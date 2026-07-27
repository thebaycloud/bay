import { test } from "node:test";
import assert from "node:assert/strict";
import { StageRecorder, durationMs, type StageRow, type StageSink } from "../lib/stages";

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
  const r = new StageRecorder("myapp", "generic", sink, clock(0, 100));

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
  const r = new StageRecorder("myapp", "fast", exploding, clock(0, 10), (e) => errors.push(e));

  const out = await r.around("build", async () => 42);

  assert.equal(out, 42, "the work still returns its value");
  assert.equal(errors.length, 1);
});

test("a broken sink does not mask a real failure either", async () => {
  const exploding: StageSink = { async write() { throw new Error("database is down"); } };
  const r = new StageRecorder("myapp", "fast", exploding, clock(0, 10), () => {});

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
    slug: "a", lane: "generic", stage: "build",
    startedAt: new Date(0), endedAt: null, outcome: null,
  };
  assert.equal(durationMs(row), null);
});
