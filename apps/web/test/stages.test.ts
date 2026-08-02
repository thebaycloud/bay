import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGE_LANES, StageRecorder, durationMs, type StageRow, type StageSink } from "../lib/stages";
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
