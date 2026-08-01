import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, granularityFor, panelError, allIssues, type ReportInput } from "../lib/analytics/report";
import type { RawStage, StageOutcome } from "../lib/analytics/attempts";
import type { AppRow, DeployStateRow, FirstDeployRow, UserRow } from "../lib/analytics/queries";

const NOW = new Date("2026-08-01T12:00:00Z");
const WINDOW = { from: new Date("2026-07-02T12:00:00Z"), to: NOW, days: 30 };

function empty(): ReportInput {
  return {
    users: [],
    apps: [],
    stages: [],
    stagesTruncated: false,
    firstDeploys: [],
    deployStates: [],
    errorEvents: [],
    oldestEventAt: null,
    slugOwners: new Map(),
    window: WINDOW,
    now: NOW,
  };
}

function user(id: string, createdAt: string, plan: string | null = "basic", status: string | null = "active"): UserRow {
  return { id, email: `${id}@example.com`, createdAt: new Date(createdAt), plan, status, provider: "google" };
}

function app(slug: string, ownerId: string, createdAt: string, status = "live"): AppRow {
  return { slug, ownerId, status, visibility: "private", createdAt: new Date(createdAt) };
}

function stage(
  slug: string,
  stageName: string,
  atIso: string,
  lastedSec: number | null,
  outcome: StageOutcome | null = "ok",
  lane = "generic",
): RawStage {
  const startedAt = new Date(atIso);
  return {
    slug,
    lane,
    stage: stageName,
    startedAt,
    endedAt: lastedSec === null ? null : new Date(startedAt.getTime() + lastedSec * 1000),
    outcome,
  };
}

/** One deploy's worth of rows: the handoff, then the deploy itself. */
function deployRows(slug: string, atIso: string, lane: string, outcome: StageOutcome, coldSec = 200): RawStage[] {
  const t = new Date(atIso).getTime();
  const at = (offsetSec: number) => new Date(t + offsetSec * 1000).toISOString();
  return [
    stage(slug, "run-record", at(0), 1),
    stage(slug, "job-dispatch", at(1), 2),
    stage(slug, "job-cold-start", at(0), coldSec),
    stage(slug, "run-fetch", at(coldSec - 10), 10),
    stage(slug, "clone", at(coldSec), 5),
    stage(slug, "detect", at(coldSec + 5), 1),
    stage(slug, "deploy", at(coldSec + 10), 60, outcome, lane),
  ];
}

// ─── the empty database ───────────────────────────────────────────────────────

// Nobody has ever looked at deploy_stages, so "the table is empty" is the state
// this page is most likely to meet first. It must say nothing rather than zero.
test("an empty database produces a report, not a crash and not a wall of zeroes", () => {
  const r = buildReport(empty());
  assert.equal(r.noStageData, true);
  assert.equal(r.acquisition.totalUsers, 0);
  assert.equal(r.acquisition.steps[0].ofTop, null);
  assert.equal(r.activation.rate, null);
  assert.equal(r.activation.lag, null);
  assert.equal(r.reliability.rate, null);
  assert.equal(r.reliability.repairRate, null);
  assert.equal(r.speed.overall, null);
  assert.deepEqual(r.speed.stages, []);
  assert.equal(r.depth.appsPerUser, null);
  assert.equal(r.depth.retention.rate, null);
  // The signup chart still has its buckets, so the page renders an empty chart
  // rather than nothing at all.
  assert.equal(r.acquisition.signups.length, 31);
});

test("users but no deploys reports where they stalled", () => {
  const input = empty();
  input.users = [user("u1", "2026-07-10T00:00:00Z"), user("u2", "2026-07-11T00:00:00Z")];
  input.apps = [app("aaa11", "u1", "2026-07-10T01:00:00Z", "deploying")];
  input.slugOwners = new Map([["aaa11", "u1"]]);

  const r = buildReport(input);
  assert.equal(r.acquisition.stalledBeforeApp, 1); // u2 never made an app
  assert.equal(r.acquisition.stalledBeforeDeploy, 1); // u1's app left no stage rows
  assert.equal(r.acquisition.stalledBeforeSuccess, 0);
  assert.equal(r.acquisition.steps[1].count, 1);
  assert.equal(r.acquisition.steps[2].count, 0);
});

// ─── acquisition and activation ───────────────────────────────────────────────

test("the funnel narrows from signup to a first working deploy", () => {
  const input = empty();
  input.users = [user("u1", "2026-07-10T00:00:00Z"), user("u2", "2026-07-11T00:00:00Z"), user("u3", "2026-07-12T00:00:00Z")];
  input.apps = [app("aaa11", "u1", "2026-07-10T01:00:00Z"), app("bbb22", "u2", "2026-07-11T01:00:00Z")];
  input.slugOwners = new Map([["aaa11", "u1"], ["bbb22", "u2"]]);
  input.firstDeploys = [
    { slug: "aaa11", firstStageAt: new Date("2026-07-10T01:00:00Z"), firstSuccessAt: new Date("2026-07-10T01:05:00Z") },
    { slug: "bbb22", firstStageAt: new Date("2026-07-11T01:00:00Z"), firstSuccessAt: null },
  ] satisfies FirstDeployRow[];

  const r = buildReport(input);
  assert.deepEqual(r.acquisition.steps.map((s) => s.count), [3, 2, 2, 1]);
  assert.equal(r.acquisition.steps[3].ofTop, 1 / 3);
  assert.equal(r.acquisition.stalledBeforeApp, 1); // u3
  assert.equal(r.acquisition.stalledBeforeSuccess, 1); // u2 deployed, never succeeded
});

test("activation is timed from signing up, not from the first attempt", () => {
  const input = empty();
  input.users = [user("u1", "2026-07-10T00:00:00Z")];
  input.apps = [app("aaa11", "u1", "2026-07-10T00:00:00Z")];
  input.slugOwners = new Map([["aaa11", "u1"]]);
  // Signed up at 00:00, first success at 02:00 — two hours, including the time
  // they spent stuck, which is the point.
  input.firstDeploys = [{ slug: "aaa11", firstStageAt: new Date("2026-07-10T01:00:00Z"), firstSuccessAt: new Date("2026-07-10T02:00:00Z") }];

  const r = buildReport(input);
  assert.equal(r.activation.activated, 1);
  assert.equal(r.activation.rate, 1);
  assert.equal(r.activation.lag!.p50, 2 * 3600_000);
});

test("a user's activation is their earliest success across all their apps", () => {
  const input = empty();
  input.users = [user("u1", "2026-07-10T00:00:00Z")];
  input.slugOwners = new Map([["aaa11", "u1"], ["bbb22", "u1"]]);
  input.firstDeploys = [
    { slug: "aaa11", firstStageAt: new Date("2026-07-12T00:00:00Z"), firstSuccessAt: new Date("2026-07-12T00:00:00Z") },
    { slug: "bbb22", firstStageAt: new Date("2026-07-11T00:00:00Z"), firstSuccessAt: new Date("2026-07-11T00:00:00Z") },
  ];

  const r = buildReport(input);
  assert.equal(r.activation.activated, 1);
  assert.equal(r.activation.lag!.p50, 24 * 3600_000);
});

// A success stamped before the account existed means the two tables disagree.
// Folding it in as a negative would drag the median below anything real.
test("a success recorded before the account existed counts but is not timed", () => {
  const input = empty();
  input.users = [user("u1", "2026-07-10T00:00:00Z")];
  input.slugOwners = new Map([["aaa11", "u1"]]);
  input.firstDeploys = [{ slug: "aaa11", firstStageAt: new Date("2026-01-01T00:00:00Z"), firstSuccessAt: new Date("2026-01-01T00:00:00Z") }];

  const r = buildReport(input);
  assert.equal(r.activation.activated, 1);
  assert.equal(r.activation.untimeable, 1);
  assert.equal(r.activation.lag, null);
});

test("an app whose owner is unknown is left out of the funnel rather than guessed at", () => {
  const input = empty();
  input.users = [user("u1", "2026-07-10T00:00:00Z")];
  input.slugOwners = new Map(); // the app's rows are gone from both tables
  input.firstDeploys = [{ slug: "ghost", firstStageAt: new Date("2026-07-11T00:00:00Z"), firstSuccessAt: new Date("2026-07-11T00:00:00Z") }];

  const r = buildReport(input);
  assert.equal(r.acquisition.steps[2].count, 0);
  assert.equal(r.activation.activated, 0);
});

// ─── reliability ──────────────────────────────────────────────────────────────

test("success rate counts deploys, and the repair agent's retries are not deploys", () => {
  const input = empty();
  input.stages = [
    ...deployRows("aaa11", "2026-07-20T10:00:00Z", "runner", "ok"),
    ...deployRows("bbb22", "2026-07-20T11:00:00Z", "static", "failed"),
  ];
  // A third deploy the repair agent rescued after two failed rounds.
  const rescued = deployRows("ccc33", "2026-07-20T12:00:00Z", "runner", "failed");
  rescued.push(stage("ccc33", "deploy", "2026-07-20T12:08:00Z", 60, "failed", "runner"));
  rescued.push(stage("ccc33", "repair-agent", "2026-07-20T12:05:00Z", 400, "ok", "runner"));
  input.stages.push(...rescued);

  const r = buildReport(input);
  assert.equal(r.reliability.attempts, 3);
  assert.equal(r.reliability.ok, 2);
  assert.equal(r.reliability.failed, 1);
  assert.equal(r.reliability.rate, 2 / 3);
  assert.equal(r.reliability.repairRuns, 1);
  assert.equal(r.reliability.repairHelped, 1);
  assert.equal(r.reliability.repairRate, 1);
});

test("lanes are read past the placeholder, and an unused lane is still listed", () => {
  const input = empty();
  input.stages = [
    ...deployRows("aaa11", "2026-07-20T10:00:00Z", "static", "ok"),
    ...deployRows("bbb22", "2026-07-20T11:00:00Z", "static", "failed"),
    ...deployRows("ccc33", "2026-07-20T12:00:00Z", "runner", "ok"),
  ];

  const r = buildReport(input);
  const lanes = new Map(r.reliability.byLane.map((l) => [l.lane, l]));
  assert.equal(lanes.get("static")!.total, 2);
  assert.equal(lanes.get("static")!.rate, 0.5);
  assert.equal(lanes.get("runner")!.rate, 1);
  // Nobody used the fast lane this window. That is a finding; a row that
  // disappears cannot report it.
  assert.equal(lanes.get("fast")!.total, 0);
  assert.equal(lanes.get("fast")!.rate, null);
});

test("a deploy that never chose a lane is counted and kept out of every lane", () => {
  const input = empty();
  // The refusal path: handoff, clone, detect, stop.
  input.stages = deployRows("aaa11", "2026-07-20T10:00:00Z", "runner", "ok").slice(0, 6);

  const r = buildReport(input);
  assert.equal(r.reliability.attempts, 1);
  assert.equal(r.reliability.neverChoseLane, 1);
  assert.equal(r.reliability.byLane.reduce((n, l) => n + l.total, 0), 0);
  // No verdict either way — it neither succeeded nor reported a failure.
  assert.equal(r.reliability.unknown, 1);
  assert.equal(r.reliability.rate, null);
});

test("failure reasons are counted from both sources, and each is reported separately", () => {
  const input = empty();
  input.errorEvents = [
    { slug: "a", message: 'npm start → Missing script "start"', at: new Date("2026-07-20T10:00:00Z") },
    { slug: "b", message: "sh: 1: fastapi: not found", at: new Date("2026-07-20T11:00:00Z") },
    { slug: "c", message: "Build failed: npm ERR!", at: new Date("2026-07-20T12:00:00Z") },
  ];
  input.deployStates = [
    { slug: "a", ownerId: "u1", status: "failed", error: "the container didn't start on $PORT", updatedAt: null, finishedAt: null },
    { slug: "z", ownerId: "u1", status: "live", error: null, updatedAt: null, finishedAt: null },
  ] satisfies DeployStateRow[];

  const r = buildReport(input);
  assert.deepEqual(r.reliability.reasonsFromEvents, [
    { reason: "run command wrong", count: 2 },
    { reason: "build failed", count: 1 },
  ]);
  // A live app contributes no reason at all.
  assert.deepEqual(r.reliability.reasonsFromAppState, [{ reason: "container did not start", count: 1 }]);
});

test("the success rate over time has a bucket for every day, empty ones included", () => {
  const input = empty();
  input.stages = [
    ...deployRows("aaa11", "2026-07-20T10:00:00Z", "runner", "ok"),
    ...deployRows("bbb22", "2026-07-20T11:00:00Z", "runner", "failed"),
  ];

  const r = buildReport(input);
  assert.equal(r.reliability.overTime.length, 31);
  const day = r.reliability.overTime.find((b) => b.key === "2026-07-20")!;
  assert.equal(day.total, 2);
  assert.equal(day.rate, 0.5);
  // A day with no deploys has no rate, rather than a rate of zero.
  assert.equal(r.reliability.overTime.find((b) => b.key === "2026-07-21")!.rate, null);
});

// ─── speed ────────────────────────────────────────────────────────────────────

test("stages are ranked by where the time actually goes", () => {
  const input = empty();
  input.stages = [
    ...deployRows("aaa11", "2026-07-20T10:00:00Z", "runner", "ok", 227),
    ...deployRows("bbb22", "2026-07-20T11:00:00Z", "runner", "ok", 227),
  ];

  const r = buildReport(input);
  assert.equal(r.speed.stages[0].stage, "job-cold-start");
  assert.equal(r.speed.stages[0].p50, 227_000);
  assert.equal(r.speed.stages[0].n, 2);
  assert.equal(r.speed.stages[1].stage, "deploy");
});

// run-fetch is measured inside job-cold-start, so adding both counts the same
// seconds twice and yields a "total" longer than the deploys it describes.
test("a stage measured inside another is marked and left out of the total", () => {
  const input = empty();
  input.stages = deployRows("aaa11", "2026-07-20T10:00:00Z", "runner", "ok", 200);

  const r = buildReport(input);
  const runFetch = r.speed.stages.find((s) => s.stage === "run-fetch")!;
  assert.equal(runFetch.nestedIn, "job-cold-start");
  const coldStart = r.speed.stages.find((s) => s.stage === "job-cold-start")!;
  assert.equal(coldStart.nestedIn, null);

  // Accounted time is the union of the deploy's stage intervals. In this fixture
  // detect ends at 206s and deploy starts at 210s, so 4 seconds of the 270-second
  // deploy are covered by no stage at all — which is the number this metric
  // exists to expose.
  assert.equal(r.speed.overall!.p50, 270_000);
  assert.equal(r.speed.accounted!.p50, 266_000);

  // Summing the durations instead would claim more time than the deploy took,
  // because job-cold-start contains both run-fetch and job-dispatch.
  const naiveSum = r.attempts[0].stages.reduce((n, s) => n + (s.endedAt!.getTime() - s.startedAt.getTime()), 0);
  assert.ok(naiveSum > r.speed.overall!.p50, "summing durations should overcount, which is the point");
});

// The first fixture this page was rendered against produced "12m 26s of stages"
// against a "5m 43s median deploy", because repair-agent runs on a minority of
// deploys and its median was added to every other stage's. Summing within each
// deploy is what makes the comparison mean anything.
test("accounted time never exceeds the deploy, even when a stage runs on a minority", () => {
  const input = empty();
  input.stages = [
    ...deployRows("aaa11", "2026-07-20T10:00:00Z", "runner", "ok", 30),
    ...deployRows("bbb22", "2026-07-20T11:00:00Z", "runner", "ok", 30),
    ...deployRows("ccc33", "2026-07-20T12:00:00Z", "runner", "ok", 30),
  ];
  // One deploy in three also ran the repair agent, for far longer than anything else.
  input.stages.push(stage("ccc33", "repair-agent", "2026-07-20T12:01:40Z", 900, "ok", "runner"));

  const r = buildReport(input);
  assert.ok(
    r.speed.accounted!.p50 <= r.speed.overall!.p50,
    `accounted ${r.speed.accounted!.p50} exceeds deploy ${r.speed.overall!.p50}`,
  );
  // Whereas adding the per-stage medians up would claim more than a deploy takes.
  const naive = r.speed.stages.filter((s) => !s.nestedIn).reduce((n, s) => n + s.p50, 0);
  assert.ok(naive > r.speed.overall!.p50, "the fixture should reproduce the misleading sum");
});

test("deploy duration is reported per lane", () => {
  const input = empty();
  input.stages = [
    ...deployRows("aaa11", "2026-07-20T10:00:00Z", "static", "ok", 20),
    ...deployRows("bbb22", "2026-07-20T11:00:00Z", "runner", "ok", 300),
  ];

  const r = buildReport(input);
  assert.equal(r.speed.byLane[0].lane, "runner");
  assert.equal(r.speed.byLane[1].lane, "static");
  assert.ok(r.speed.byLane[0].p50 > r.speed.byLane[1].p50);
});

test("a deploy still running contributes no duration", () => {
  const input = empty();
  const rows = deployRows("aaa11", "2026-07-20T10:00:00Z", "runner", "ok");
  rows[rows.length - 1] = stage("aaa11", "deploy", "2026-07-20T10:03:30Z", null, null, "runner");
  input.stages = rows;

  const r = buildReport(input);
  assert.equal(r.speed.overall, null);
  assert.equal(r.reliability.unknown, 1);
});

// ─── retention and depth ──────────────────────────────────────────────────────

test("retention counts only the people who have had time to come back", () => {
  const input = empty();
  input.users = [
    user("u1", "2026-07-01T00:00:00Z"), // old enough, came back
    user("u2", "2026-07-01T00:00:00Z"), // old enough, did not
    user("u3", "2026-07-30T00:00:00Z"), // signed up two days ago
  ];
  input.apps = [
    app("aaa11", "u1", "2026-07-01T01:00:00Z"),
    app("bbb22", "u2", "2026-07-01T01:00:00Z"),
    app("ccc33", "u3", "2026-07-30T01:00:00Z"),
  ];
  input.deployStates = [
    { slug: "aaa11", ownerId: "u1", status: "live", error: null, updatedAt: new Date("2026-07-20T00:00:00Z"), finishedAt: new Date("2026-07-20T00:00:00Z") },
    { slug: "bbb22", ownerId: "u2", status: "live", error: null, updatedAt: new Date("2026-07-03T00:00:00Z"), finishedAt: new Date("2026-07-03T00:00:00Z") },
  ];

  const r = buildReport(input);
  assert.equal(r.depth.retention.returned, 1);
  assert.equal(r.depth.retention.didNotReturn, 1);
  assert.equal(r.depth.retention.tooEarly, 1);
  assert.equal(r.depth.retention.rate, 0.5);
});

test("apps per user is over the people who own one, and reports the shape", () => {
  const input = empty();
  input.users = [user("u1", "2026-07-01T00:00:00Z"), user("u2", "2026-07-01T00:00:00Z"), user("u3", "2026-07-01T00:00:00Z")];
  input.apps = [
    app("a", "u1", "2026-07-02T00:00:00Z"),
    app("b", "u1", "2026-07-02T00:00:00Z"),
    app("c", "u1", "2026-07-02T00:00:00Z"),
    app("d", "u2", "2026-07-02T00:00:00Z"),
  ];

  const r = buildReport(input);
  assert.equal(r.depth.appsPerUser!.n, 2); // u3 owns none and is not in the distribution
  assert.equal(r.depth.appsPerUser!.max, 3);
  assert.deepEqual(r.depth.appsPerUserHistogram, [{ apps: 1, users: 1 }, { apps: 3, users: 1 }]);
});

test("plans and statuses are tallied, and a missing value says so", () => {
  const input = empty();
  input.users = [
    user("u1", "2026-07-01T00:00:00Z", "pro", "active"),
    user("u2", "2026-07-01T00:00:00Z", "basic", "trialing"),
    user("u3", "2026-07-01T00:00:00Z", null, null),
  ];
  input.apps = [app("a", "u1", "2026-07-02T00:00:00Z", "live"), app("b", "u2", "2026-07-02T00:00:00Z", "failed")];

  const r = buildReport(input);
  assert.deepEqual(new Map(r.depth.plans.map((p) => [p.plan, p.count])), new Map([["pro", 1], ["basic", 1], ["unrecorded", 1]]));
  assert.deepEqual(new Map(r.depth.statuses.map((s) => [s.status, s.count])), new Map([["active", 1], ["trialing", 1], ["unrecorded", 1]]));
  assert.equal(r.depth.liveApps, 1);
  assert.equal(r.depth.failedApps, 1);
});

// ─── framing ──────────────────────────────────────────────────────────────────

test("a long window is bucketed by week and a short one by day", () => {
  assert.equal(granularityFor(7), "day");
  assert.equal(granularityFor(30), "day");
  assert.equal(granularityFor(90), "week");
});

test("a truncated read is carried through to the page rather than hidden", () => {
  const input = empty();
  input.stagesTruncated = true;
  const r = buildReport(input);
  assert.equal(r.truncated, true);
  assert.equal(r.reliability.truncated, true);
});

// ─── a read that failed is not a quiet week ───────────────────────────────────

// The whole point: these tables' column names were read off lib/*.ts rather than
// a migration, because `deploys` and `deploy_events` appear in no migration at
// all. A wrong name must not render as "no data" on a page whose job is to be
// believed.
test("a failed read is reported, not rendered as an empty result", () => {
  const input = empty();
  input.sources = { deployStates: 'column "finished_at" does not exist' };

  const r = buildReport(input);
  assert.deepEqual(r.issues, [{ source: "deployStates", message: 'column "finished_at" does not exist' }]);
  assert.equal(panelError(r.sources, ["deployStates"]), 'column "finished_at" does not exist');
});

test("a panel whose sources all loaded reports no error", () => {
  const r = buildReport(empty());
  assert.deepEqual(r.issues, []);
  assert.equal(panelError(r.sources, ["users", "apps", "stages"]), null);
});

test("a panel is broken if any one of its sources is", () => {
  const input = empty();
  input.sources = { apps: "relation \"apps\" does not exist" };

  const r = buildReport(input);
  // The funnel needs all three; one failure is enough to make its numbers wrong.
  assert.match(panelError(r.sources, ["users", "apps", "firstDeploys"])!, /relation "apps" does not exist/);
  // A panel that does not read apps is unaffected.
  assert.equal(panelError(r.sources, ["stages"]), null);
});

// "deploy_stages held nothing" and "we could not read deploy_stages" are
// opposite claims. Saying the first when the second happened is exactly the
// confusion this page must not create.
test("a broken stages read is never reported as 'no stage data'", () => {
  const working = buildReport(empty());
  assert.equal(working.noStageData, true, "an empty read really is no data");

  const input = empty();
  input.sources = { stages: 'column "outcome" does not exist' };
  const failed = buildReport(input);
  assert.equal(failed.noStageData, false, "a failed read must not claim there is no data");
  assert.equal(failed.issues.length, 1);
});

test("only the reads that actually failed are listed", () => {
  const input = empty();
  input.sources = { users: null, apps: "boom", stages: null, errorEvents: "bang" };
  assert.deepEqual(allIssues(input.sources).map((i) => i.source).sort(), ["apps", "errorEvents"]);
});

test("no source information at all means no issues, not unknown ones", () => {
  assert.deepEqual(allIssues(undefined), []);
  assert.equal(panelError(undefined, ["users"]), null);
  assert.deepEqual(buildReport(empty()).sources, {});
});
