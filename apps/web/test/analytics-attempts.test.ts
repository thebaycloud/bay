import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sessionizeAttempts,
  stageDurationMs,
  LANE_BLIND_STAGES,
  NESTED_STAGES,
  coveredMs,
  type RawStage,
  type StageOutcome,
} from "../lib/analytics/attempts";

/** A stage row, written the way the pipeline writes them: t and duration in seconds. */
function s(
  stage: string,
  atSec: number,
  lastedSec: number | null,
  outcome: StageOutcome | null = "ok",
  opts: { slug?: string; lane?: string } = {},
): RawStage {
  return {
    slug: opts.slug ?? "abc12",
    lane: opts.lane ?? "generic",
    stage,
    startedAt: new Date(atSec * 1000),
    endedAt: lastedSec === null ? null : new Date((atSec + lastedSec) * 1000),
    outcome,
  };
}

/** The four handoff stages every job-indirection deploy opens with. */
function handoff(atSec: number, slug = "abc12"): RawStage[] {
  return [
    s("run-record", atSec, 1, "ok", { slug }),
    s("job-dispatch", atSec + 1, 2, "ok", { slug }),
    s("job-cold-start", atSec, 200, "ok", { slug }),
    s("run-fetch", atSec + 190, 10, "ok", { slug }),
  ];
}

test("a run-record row begins a new deploy, however close it is to the last one", () => {
  const rows = [
    ...handoff(0),
    s("deploy", 210, 30, "ok", { lane: "runner" }),
    // One second later — far inside any time-gap threshold. Only the marker
    // separates these, and without it two deploys would be counted as one.
    ...handoff(241),
    s("deploy", 450, 30, "failed", { lane: "runner" }),
  ];

  const attempts = sessionizeAttempts(rows);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].outcome, "ok");
  assert.equal(attempts[1].outcome, "failed");
});

test("without a run-record marker, a long silence separates deploys", () => {
  // Rows as they look for a deploy that predates the job indirection: no marker
  // anywhere, so the only available boundary is the gap.
  const rows = [
    s("clone", 0, 5),
    s("detect", 5, 1),
    s("deploy", 10, 40, "ok", { lane: "static" }),
    s("clone", 4000, 5),
    s("detect", 4005, 1),
    s("deploy", 4010, 40, "ok", { lane: "static" }),
  ];

  const attempts = sessionizeAttempts(rows, { gapMs: 30 * 60_000 });
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].startedAt.getTime(), 0);
  assert.equal(attempts[1].startedAt.getTime(), 4_000_000);
});

test("a slow deploy is not split into several", () => {
  // 27 minutes, which is the longest real deploy on record.
  const rows = [...handoff(0), s("prepare", 210, 60, "ok", { lane: "runner" }), s("deploy", 300, 1320, "ok", { lane: "runner" })];
  assert.equal(sessionizeAttempts(rows, { gapMs: 30 * 60_000 }).length, 1);
});

// Stages nest: `run-fetch` is measured inside `job-cold-start`. Tracking "the
// last row's end" rather than "the furthest point reached" would make the deploy
// look idle from the short inner stage onwards, and split it in two.
test("a short stage inside a long one does not make the deploy look idle", () => {
  const rows = [
    s("job-cold-start", 0, 5000),
    s("run-fetch", 100, 100),
    s("deploy", 5400, 30, "ok", { lane: "runner" }),
  ];
  // The deploy row starts 400s after job-cold-start ended, but 5300s after
  // run-fetch ended. With a 1000s threshold only one of those splits it.
  const attempts = sessionizeAttempts(rows, { gapMs: 1000 * 1000 });
  assert.equal(attempts.length, 1);
});

test("the lane is read past the placeholder the pipeline starts with", () => {
  // Every early row says "generic" because the lane is not known yet. Believing
  // them files every static deploy under generic.
  const rows = [
    ...handoff(0),
    s("clone", 200, 5, "ok", { lane: "generic" }),
    s("detect", 205, 1, "ok", { lane: "generic" }),
    s("build", 210, 40, "ok", { lane: "static" }),
    s("deploy", 250, 10, "ok", { lane: "static" }),
  ];

  const attempts = sessionizeAttempts(rows);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].lane, "static");
});

test("a deploy that never chose a lane reports none, rather than guessing generic", () => {
  // The refusal path: it clones, detects, and stops. There is no lane, and
  // saying "generic" would put a refusal in the Dockerfile bucket.
  const rows = [...handoff(0), s("clone", 200, 5), s("detect", 205, 1)];

  const attempts = sessionizeAttempts(rows);
  assert.equal(attempts[0].lane, null);
  assert.equal(attempts[0].reachedDeploy, false);
  assert.equal(attempts[0].outcome, "unknown");
});

test("generic is kept when it is a real answer and not a placeholder", () => {
  // An app that ships a Dockerfile genuinely deploys on the generic lane. The
  // string is the same as the placeholder; the row it is on is what differs.
  const rows = [...handoff(0), s("clone", 200, 5), s("prepare", 210, 20, "ok", { lane: "generic" }), s("deploy", 230, 60, "ok", { lane: "generic" })];
  assert.equal(sessionizeAttempts(rows)[0].lane, "generic");
});

test("every lane-blind stage is one the pipeline writes before it knows the lane", () => {
  // A guard on the list itself: if someone moves a stage to after line 1216 and
  // forgets this set, the lane silently stops being read off it.
  for (const stage of ["run-record", "job-dispatch", "job-cold-start", "run-fetch", "clone", "detect", "infer-services"]) {
    assert.ok(LANE_BLIND_STAGES.has(stage), `${stage} should be lane-blind`);
  }
  for (const stage of ["build", "prepare", "upload", "verify", "unpack", "deploy", "repair-agent"]) {
    assert.ok(!LANE_BLIND_STAGES.has(stage), `${stage} knows its lane`);
  }
});

test("a deploy the repair agent rescued counts as a success", () => {
  const rows = [
    ...handoff(0),
    s("deploy", 210, 60, "failed", { lane: "runner" }),
    s("repair-agent", 270, 400, "ok", { lane: "runner" }),
  ];

  const a = sessionizeAttempts(rows)[0];
  assert.equal(a.outcome, "ok");
  assert.equal(a.repair, "helped");
});

test("a deploy the repair agent could not rescue counts as a failure", () => {
  const rows = [
    ...handoff(0),
    s("deploy", 210, 60, "failed", { lane: "runner" }),
    s("repair-agent", 270, 900, "failed", { lane: "runner" }),
  ];

  const a = sessionizeAttempts(rows)[0];
  assert.equal(a.outcome, "failed");
  assert.equal(a.repair, "did-not-help");
});

// The repair agent is handed runDeploy itself, so it writes more `deploy` rows
// inside the same deploy. Counting those rows counts machine attempts, not
// deploys somebody started — and overstates both the total and the failures.
test("the repair agent's retries are rounds of one deploy, not several deploys", () => {
  const rows = [
    ...handoff(0),
    s("deploy", 210, 60, "failed", { lane: "runner" }),
    s("deploy", 400, 60, "failed", { lane: "runner" }),
    s("deploy", 600, 60, "ok", { lane: "runner" }),
    s("repair-agent", 270, 400, "ok", { lane: "runner" }),
  ];

  const attempts = sessionizeAttempts(rows);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].deployRounds, 3);
  assert.equal(attempts[0].outcome, "ok");
});

test("a deploy that broke before deploying anything is a failure, not an unknown", () => {
  const rows = [...handoff(0), s("clone", 200, 5, "failed")];
  const a = sessionizeAttempts(rows)[0];
  assert.equal(a.outcome, "failed");
  assert.equal(a.reachedDeploy, false);
});

test("a skipped stage is not a failure", () => {
  const rows = [...handoff(0), s("clone", 200, 0, "skipped"), s("unpack", 200, 5, "ok", { lane: "static" }), s("deploy", 205, 20, "ok", { lane: "static" })];
  assert.equal(sessionizeAttempts(rows)[0].outcome, "ok");
});

test("a deploy with an unfinished stage has no duration", () => {
  const rows = [...handoff(0), s("deploy", 210, null, null, { lane: "runner" })];
  const a = sessionizeAttempts(rows)[0];
  assert.equal(a.endedAt, null);
  assert.equal(a.durationMs, null);
  assert.equal(a.outcome, "unknown");
});

test("a finished deploy is measured from its first stage to its last", () => {
  const rows = [...handoff(0), s("deploy", 210, 60, "ok", { lane: "runner" })];
  const a = sessionizeAttempts(rows)[0];
  assert.equal(a.durationMs, 270_000);
});

test("apps are grouped separately even when their deploys overlap", () => {
  const rows = [
    ...handoff(0, "aaa11"),
    ...handoff(30, "bbb22"),
    s("deploy", 210, 30, "ok", { slug: "aaa11", lane: "runner" }),
    s("deploy", 250, 30, "failed", { slug: "bbb22", lane: "static" }),
  ];

  const attempts = sessionizeAttempts(rows);
  assert.equal(attempts.length, 2);
  const bySlug = new Map(attempts.map((a) => [a.slug, a]));
  assert.equal(bySlug.get("aaa11")!.outcome, "ok");
  assert.equal(bySlug.get("bbb22")!.outcome, "failed");
  assert.equal(bySlug.get("bbb22")!.lane, "static");
});

test("rows in any order give the same answer", () => {
  const rows = [...handoff(0), s("deploy", 210, 60, "ok", { lane: "runner" })];
  const shuffled = [rows[4], rows[1], rows[3], rows[0], rows[2]];

  const a = sessionizeAttempts(shuffled)[0];
  assert.equal(a.startedAt.getTime(), 0);
  assert.equal(a.durationMs, 270_000);
  assert.equal(a.lane, "runner");
});

test("no rows means no deploys, not a crash", () => {
  assert.deepEqual(sessionizeAttempts([]), []);
});

test("a stage's duration is null while it is still running", () => {
  assert.equal(stageDurationMs(s("deploy", 10, 30)), 30_000);
  assert.equal(stageDurationMs(s("deploy", 10, null, null)), null);
});

// Stages overlap in at least three ways: run-fetch and job-dispatch sit inside
// job-cold-start, and run-record only partly overlaps it because the run row's
// created_at is written midway through. Enumerating the overlaps can only ever
// describe the ones somebody remembered, so the intervals are merged instead.
test("covered time counts overlapping stages once", () => {
  assert.equal(coveredMs([s("a", 0, 10), s("b", 0, 10)]), 10_000);
  assert.equal(coveredMs([s("outer", 0, 100), s("inner", 20, 30)]), 100_000);
  // Partial overlap: 0–10 and 5–20 cover 0–20.
  assert.equal(coveredMs([s("a", 0, 10), s("b", 5, 15)]), 20_000);
});

test("covered time adds up disjoint stages and the gaps between them are not covered", () => {
  assert.equal(coveredMs([s("a", 0, 10), s("b", 100, 10)]), 20_000);
});

test("covered time ignores stages that never finished or took no time", () => {
  assert.equal(coveredMs([s("a", 0, 10), s("b", 50, null, null)]), 10_000);
  assert.equal(coveredMs([s("a", 0, 0)]), 0);
  assert.equal(coveredMs([]), 0);
});

test("covered time does not depend on the order rows arrive in", () => {
  const rows = [s("c", 50, 20), s("a", 0, 10), s("b", 5, 15)];
  assert.equal(coveredMs(rows), coveredMs([...rows].reverse()));
});

// The property that makes the number safe to put beside a deploy duration.
test("covered time can never exceed the span of the deploy it describes", () => {
  const rows = [...handoff(0), s("deploy", 210, 60, "ok", { lane: "runner" })];
  const a = sessionizeAttempts(rows)[0];
  assert.ok(coveredMs(a.stages) <= a.durationMs!, `${coveredMs(a.stages)} > ${a.durationMs}`);
});

// fleet-pull and fleet-boot are written on every successful process start —
// a crash-loop restart or a node reboot as much as a deploy — with no run id
// to say which attempt they belong to. Grouping them by proximity, the way
// every other stage is grouped, folds a restart landing soon after a deploy's
// last real stage into that deploy: this is the 1m34s-shown-as-23m57s bug
// `lib/deploys.ts` records, reached through the analytics path instead of the
// dashboard-card path.
test("a restart row inside the gap window does not extend the attempt it lands near", () => {
  const rows = [
    ...handoff(0),
    s("deploy", 210, 30, "ok", { lane: "runner" }),
    // 5 minutes after the deploy's last stage ended — well inside the 30
    // minute gap — a crash-loop restart writes its own pull/boot timing, with
    // the "unknown" lane recordStartTiming always writes, and an end far past
    // the deploy's own.
    s("fleet-pull", 540, 30, "ok", { lane: "unknown" }),
    s("fleet-boot", 570, 300, "ok", { lane: "unknown" }),
  ];

  const attempts = sessionizeAttempts(rows);
  assert.equal(attempts.length, 1);
  const a = attempts[0];
  // Without the fix this is 870_000 (240s deploy start to the restart's end
  // at t=870) instead of the deploy's own 240_000.
  assert.equal(a.durationMs, 240_000);
  assert.equal(a.endedAt?.getTime(), 240_000);
  // The restart's "unknown" lane must not overwrite the lane the real deploy
  // stages already established.
  assert.equal(a.lane, "runner");
});

// A silence bridged only by a restart is not silence a real deploy filled —
// two attempts 40 minutes apart (past the 30 minute gap on either side of the
// restart) must stay two, not merge into one because the restart's end
// advanced `reachedAt` far enough to close the gap between them.
test("a restart row does not bridge a gap that would otherwise split two attempts", () => {
  const rows = [
    ...handoff(0),
    s("deploy", 210, 30, "ok", { lane: "runner" }),
    // A reboot 20 minutes after the first deploy ends.
    s("fleet-boot", 1440, 5, "ok", { lane: "unknown" }),
    // The next real deploy starts 20 minutes after the reboot — 40 minutes
    // after the first deploy's own last stage, so on either side of the
    // restart the real silence is well past the 30 minute gap.
    ...handoff(2640),
    s("deploy", 2850, 30, "ok", { lane: "runner" }),
  ];

  const attempts = sessionizeAttempts(rows);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].endedAt?.getTime(), 240_000);
  assert.equal(attempts[1].startedAt.getTime(), 2_640_000);
});

test("a slug whose rows are only restarts produces no attempt at all", () => {
  const rows = [s("fleet-pull", 0, 30, "ok", { lane: "unknown" }), s("fleet-boot", 30, 300, "ok", { lane: "unknown" })];
  assert.deepEqual(sessionizeAttempts(rows), []);
});

test("job-dispatch is recorded as nested, because the job cannot start before it is dispatched", () => {
  const nested = new Map(NESTED_STAGES.map(([inner, outer]) => [inner, outer]));
  assert.equal(nested.get("job-dispatch"), "job-cold-start");
  assert.equal(nested.get("run-fetch"), "job-cold-start");
  // run-record only partially overlaps, so claiming containment would be wrong.
  assert.equal(nested.has("run-record"), false);
});
