import { test } from "node:test";
import assert from "node:assert/strict";
import { StageRecorder } from "../lib/stages";
import type { StageRow, StageSink } from "../lib/stages";

/**
 * Stages were keyed by (slug, started_at) and nothing else, so the only way to
 * bound one deploy was a time window — thirty minutes, in the reader. Every
 * attempt inside it collapsed into a single duration.
 *
 * Measured on the dashboard's own cards: an app whose deploy took 1m 34s from
 * build start to publish was shown as "DEPLOYED IN 23m 57s", because four
 * attempts and a repair-agent run had happened in the preceding half hour. The
 * error is always upward, and it grows with how often somebody redeploys — so
 * the number lied hardest while a person was debugging and reading it most.
 */

function recorder(rows: StageRow[], runId?: string | null) {
  const sink: StageSink = { async write(row) { rows.push(row); } };
  return new StageRecorder("app", "container", sink, () => new Date("2026-08-06T12:00:00Z"), () => {}, { runId });
}

test("a stage carries the deploy it belongs to", () => {
  const rows: StageRow[] = [];
  const r = recorder(rows, "run-abc");
  return r.end(r.start("build"), "ok").then(() => {
    assert.equal(rows[0].runId, "run-abc");
  });
});

test("every stage of one deploy carries the same id", () => {
  // The whole point: min/max over these rows has to describe ONE deploy. Two
  // ids inside one deploy would split it and report half the time.
  const rows: StageRow[] = [];
  const r = recorder(rows, "run-abc");
  return Promise.all([
    r.end(r.start("build"), "ok"),
    r.end(r.start("deploy"), "ok"),
    r.end(r.start("verify"), "ok"),
  ]).then(() => {
    assert.deepEqual([...new Set(rows.map((x) => x.runId))], ["run-abc"]);
  });
});

test("no id is null, not a crash and not an empty string", () => {
  // Every caller that predates this keeps working, and the reader can tell
  // "written before the column" from "written with an id" — which is what
  // decides whether it scopes by run or falls back to the window.
  const rows: StageRow[] = [];
  const r = recorder(rows);
  return r.end(r.start("build"), "ok").then(() => {
    assert.equal(rows[0].runId, null);
  });
});

test("a failed stage still records its deploy", () => {
  // The failing attempt is exactly the one whose duration a person wants, and
  // dropping the id there would push it back into the window fallback.
  const rows: StageRow[] = [];
  const r = recorder(rows, "run-abc");
  return r.end(r.start("build"), "failed").then(() => {
    assert.equal(rows[0].runId, "run-abc");
    assert.equal(rows[0].outcome, "failed");
  });
});
