import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGE_LANES, StageRecorder, durationMs, type StageRow, type StageSink } from "../lib/stages";
import {
  ACTIVATION_STAGE, ALL_STAGES, ATTEMPT_START_STAGE,
  HANDOFF_STAGES, LANE_KNOWN_STAGES, PRE_LANE_STAGES,
} from "../lib/stage-names";
import { LANE_BLIND_STAGES } from "../lib/analytics/attempts";
import { ALL_LANES } from "../lib/lanes";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function recordingSink() {
  const rows: StageRow[] = [];
  const sink: StageSink = { async write(r) { rows.push(r); } };
  return { sink, rows };
}

/** A clock that advances a fixed amount on every read. */
function clock(startMs: number, stepMs: number) {
  let t = startMs;
  return () => { const now = new Date(t); t += stepMs; return now; };
}

/* -------------------------------------------------------------------------- */
/* The stage names are an API                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every stage name the code actually writes, read out of the source.
 *
 * A source-level test, and the same idiom this repo already uses for facts a unit
 * test cannot reach: plan-deps.test.ts parses both runner Dockerfiles, and the
 * test below parses a migration. What is being defended here is not behaviour, it
 * is a STRING agreeing across four files — and every way of getting it wrong
 * produces a well-formed query returning zero rather than an error.
 */
const EMITTERS = ["lib/deploy-pipeline.ts", "app/api/deploy/route.ts", "scripts/deploy-job.ts"];

function emittedStages(): Set<string> {
  const found = new Set<string>();
  for (const rel of EMITTERS) {
    const src = readFileSync(join(__dirname, "..", rel), "utf8");
    // `.around("build"`, `.start("repair-agent"`, `.skipped("clone"`, and
    // `{ stage: "job-cold-start"` for the handoff rows written by hand.
    for (const m of src.matchAll(/\.(?:around|start|skipped)\(\s*"([a-z-]+)"/g)) found.add(m[1]);
    for (const m of src.matchAll(/\bstage:\s*"([a-z-]+)"/g)) found.add(m[1]);
    // …and the ones emitted through the constant rather than a literal.
    if (/\.(?:around|start|skipped)\(\s*ACTIVATION_STAGE/.test(src)) found.add(ACTIVATION_STAGE);
  }
  return found;
}

test("every stage the code writes is in the vocabulary", () => {
  // `deploy_stages.stage` has no CHECK constraint — 004 constrains only
  // `outcome`, and `lane`'s is deferred to phase two by 012 — so a typo is not
  // rejected by anything. It becomes a row nobody queries.
  const emitted = emittedStages();
  assert.ok(emitted.size >= 10, `only found ${emitted.size} stage emitters — the extractor is not matching`);
  for (const stage of emitted) {
    assert.ok(ALL_STAGES.includes(stage), `"${stage}" is written but is not in ALL_STAGES`);
  }
});

test("the two stages the analytics turn on are still emitted", () => {
  // Activation is `min(ended_at) FILTER (WHERE stage = 'deploy' AND outcome =
  // 'ok')` with no WHERE and no window, and `run-record` is what splits rows into
  // deploys at all. Neither query fails when its stage stops being written; the
  // first returns null for every app and the second returns one enormous deploy.
  const emitted = emittedStages();
  assert.ok(emitted.has(ACTIVATION_STAGE), `nothing emits "${ACTIVATION_STAGE}" — activation would be null for every app`);
  assert.ok(emitted.has(ATTEMPT_START_STAGE), `nothing emits "${ATTEMPT_START_STAGE}" — deploys would not be split`);
});

test("a prebuilt publish counts as having gone live", () => {
  // It never did. `publishPrebuilt` writes unpack, upload and verify and the
  // caller then returns, so `--prebuilt` produced no activation row at all and
  // every such app has read as never deployed since the metric was written.
  const src = readFileSync(join(__dirname, "..", "lib/deploy-pipeline.ts"), "utf8");
  const prebuilt = src.slice(src.indexOf("if (isPrebuilt && archive) {"));
  const block = prebuilt.slice(0, prebuilt.indexOf("\n    }"));

  assert.match(block, /stages\.around\(ACTIVATION_STAGE/);
  assert.ok(
    block.indexOf("stages.around(ACTIVATION_STAGE") < block.indexOf("publishPrebuilt("),
    "the activation stage must wrap the publish, so ended_at is when the app became reachable",
  );
});

test("the lane-blind set is derived, and its membership did not move", () => {
  // It was seven hand-written strings in a file whose own header is about a
  // vocabulary that drifted from the pipeline's — the same list written twice is
  // exactly how that happened. Deriving it must not quietly reclassify anything:
  // `lane` is taken from the last stage NOT in this set, so a name moving in or
  // out changes which lane a deploy is charged to, retroactively.
  assert.deepEqual([...LANE_BLIND_STAGES].sort(), [
    "clone", "detect", "infer-services", "job-cold-start", "job-dispatch", "run-fetch", "run-record",
  ]);
  assert.deepEqual([...LANE_BLIND_STAGES].sort(), [...HANDOFF_STAGES, ...PRE_LANE_STAGES].sort());

  // …and the two halves are disjoint, or a stage would be both blind and evidence.
  for (const s of LANE_KNOWN_STAGES) assert.ok(!LANE_BLIND_STAGES.has(s), `"${s}" is both lane-known and lane-blind`);
  assert.ok(LANE_KNOWN_STAGES.includes(ACTIVATION_STAGE), "activation must be charged to a lane");
});

test("a completed stage records its duration and outcome", async () => {
  const { sink, rows } = recordingSink();
  const r = new StageRecorder("myapp", "static", sink, clock(1_000, 2_500));

  await r.around("build", async () => "done");

  assert.equal(rows.length, 1);
  assert.equal(rows[0].slug, "myapp");
  assert.equal(rows[0].lane, "static");
  assert.equal(rows[0].stage, "build");
  assert.equal(rows[0].outcome, "ok");
  assert.equal(durationMs(rows[0]), 2_500);
});

test("a failing stage is recorded as failed and the error still propagates", async () => {
  const { sink, rows } = recordingSink();
  const r = new StageRecorder("myapp", "container", sink, clock(0, 100));

  await assert.rejects(
    () => r.around("clone", async () => { throw new Error("git exploded"); }),
    /git exploded/,
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "failed");
  assert.equal(durationMs(rows[0]), 100);
});

test("a broken sink never fails the deploy", async () => {
  // The property this whole class exists to guarantee: losing telemetry costs us
  // the measurement, never the customer's deploy.
  const errors: unknown[] = [];
  const exploding: StageSink = { async write() { throw new Error("database is down"); } };
  const r = new StageRecorder("myapp", "buildpack", exploding, clock(0, 10), (e) => errors.push(e));

  const out = await r.around("build", async () => 42);

  assert.equal(out, 42, "the work still returns its value");
  assert.equal(errors.length, 1);
});

test("a broken sink does not mask a real failure either", async () => {
  const exploding: StageSink = { async write() { throw new Error("database is down"); } };
  const r = new StageRecorder("myapp", "buildpack", exploding, clock(0, 10), () => {});

  await assert.rejects(
    () => r.around("build", async () => { throw new Error("build failed"); }),
    /build failed/,
    "the deploy error survives, not the telemetry error",
  );
});

test("a skipped stage is recorded with zero work", async () => {
  const { sink, rows } = recordingSink();
  const r = new StageRecorder("myapp", "static", sink, clock(5_000, 0));

  await r.skipped("provision-database");

  assert.equal(rows[0].stage, "provision-database");
  assert.equal(rows[0].outcome, "skipped");
  assert.equal(durationMs(rows[0]), 0);
});

test("stages are recorded in the order they finish", async () => {
  const { sink, rows } = recordingSink();
  const r = new StageRecorder("myapp", "static", sink, clock(0, 1_000));

  await r.around("clone", async () => {});
  await r.around("detect", async () => {});
  await r.around("upload", async () => {});

  assert.deepEqual(rows.map((x) => x.stage), ["clone", "detect", "upload"]);
});

test("a stage still running has no duration", () => {
  const row: StageRow = {
    slug: "a", lane: "container", stage: "build",
    startedAt: new Date(0), endedAt: null, outcome: null,
  };
  assert.equal(durationMs(row), null);
});

test("the recorded vocabulary is the executed one, and the database agrees", () => {
  // The defect this locks out: `lib/stages.ts` used to export its own
  // `export type Lane = "static" | "fast" | "generic" | "runner"` beside
  // `lib/lanes.ts`'s `"static" | "runner" | "container" | "buildpack"`. Same
  // name, two modules, overlapping on two values. TypeScript cannot catch that —
  // separate declarations — and `deploy_stages.lane` was `text NOT NULL`, so
  // Postgres could not either. So `deploy_stages` collected data from 004 onward
  // that could not answer the question 004 was created to ask.
  //
  // Three things now have to agree, and nothing but this test makes them.
  assert.deepEqual(STAGE_LANES, ["unknown", "static", "runner", "container", "buildpack"]);
  for (const lane of ALL_LANES) assert.ok(STAGE_LANES.includes(lane), `${lane} deploys but cannot be recorded`);

  // The database CHECK is phase THREE of a two-phase change and is not applied
  // yet — see db/012_stage_lane_check_is_phase_two.sql for why 011 adding it was
  // wrong, and what it cost. Until it lands, THIS test is the only thing holding
  // the vocabularies together, so it asserts against the statement the migration
  // will use rather than against a live constraint.
  const phase3 = readFileSync(join(import.meta.dirname, "../db/012_stage_lane_check_is_phase_two.sql"), "utf8");
  const check = /CHECK \(lane IN \(([^)]*)\)\)/.exec(phase3);
  assert.ok(check, "the migration no longer records the constraint to apply, so nothing pins the vocabulary");
  const allowed = check[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));

  assert.deepEqual(allowed.slice().sort(), STAGE_LANES.slice().sort());
});
