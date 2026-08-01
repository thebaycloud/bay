import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dayKey,
  weekKey,
  denseSeries,
  rate,
  formatRate,
  percentile,
  summarize,
  weekOneVerdict,
  retentionSummary,
  funnel,
  formatDuration,
  groupBy,
  classifyFailure,
} from "../lib/analytics/metrics";

const D = (iso: string) => new Date(iso);

test("days and weeks are UTC, not the viewer's midnight", () => {
  // 23:30 UTC on the 1st is still the 1st, wherever the operator is sitting.
  assert.equal(dayKey(D("2026-08-01T23:30:00Z")), "2026-08-01");
  assert.equal(dayKey(D("2026-08-01T00:00:00Z")), "2026-08-01");
});

test("a week starts on Monday and a Sunday belongs to the week before", () => {
  assert.equal(weekKey(D("2026-07-27T00:00:00Z")), "2026-07-27"); // Monday
  assert.equal(weekKey(D("2026-07-30T12:00:00Z")), "2026-07-27"); // Thursday
  assert.equal(weekKey(D("2026-08-02T23:59:00Z")), "2026-07-27"); // Sunday
  assert.equal(weekKey(D("2026-08-03T00:00:00Z")), "2026-08-03"); // next Monday
});

test("a week boundary works across a month and a year", () => {
  assert.equal(weekKey(D("2026-03-01T12:00:00Z")), "2026-02-23");
  assert.equal(weekKey(D("2026-01-01T12:00:00Z")), "2025-12-29");
});

// A chart built only from the days something happened puts two bars side by side
// and reads as steady use, when the truth was two deploys a fortnight apart.
test("the days nothing happened are in the series", () => {
  const s = denseSeries(
    [D("2026-07-28T10:00:00Z"), D("2026-07-28T11:00:00Z"), D("2026-07-31T09:00:00Z")],
    "day",
    D("2026-07-27T00:00:00Z"),
    D("2026-08-01T00:00:00Z"),
  );
  assert.deepEqual(s, [
    { key: "2026-07-27", count: 0 },
    { key: "2026-07-28", count: 2 },
    { key: "2026-07-29", count: 0 },
    { key: "2026-07-30", count: 0 },
    { key: "2026-07-31", count: 1 },
    { key: "2026-08-01", count: 0 },
  ]);
});

test("a weekly series starts on the Monday of the range, not the range's first day", () => {
  const s = denseSeries([D("2026-07-30T09:00:00Z")], "week", D("2026-07-29T00:00:00Z"), D("2026-08-05T00:00:00Z"));
  assert.deepEqual(s, [
    { key: "2026-07-27", count: 1 },
    { key: "2026-08-03", count: 0 },
  ]);
});

test("an empty range still produces its buckets", () => {
  const s = denseSeries([], "day", D("2026-08-01T00:00:00Z"), D("2026-08-02T00:00:00Z"));
  assert.deepEqual(s, [
    { key: "2026-08-01", count: 0 },
    { key: "2026-08-02", count: 0 },
  ]);
});

// "0% of users activated" is a claim about the product. "No users yet" is a
// claim about the data. Rendering the second as the first is the single easiest
// way for this page to mislead somebody.
test("a rate over nothing is not zero", () => {
  assert.equal(rate(0, 0), null);
  assert.equal(rate(3, 0), null);
  assert.equal(formatRate(rate(0, 0)), "—");
  assert.equal(rate(0, 5), 0);
  assert.equal(formatRate(rate(0, 5)), "0%");
});

test("a rate reads as a percentage", () => {
  assert.equal(formatRate(rate(1, 3), 1), "33.3%");
  assert.equal(formatRate(rate(2, 2)), "100%");
});

test("percentiles are taken over sorted values, whatever order they arrive in", () => {
  const v = [50, 10, 40, 20, 30];
  assert.equal(percentile(v, 50), 30);
  assert.equal(percentile(v, 90), 50);
  assert.equal(percentile(v, 0), 10);
  assert.equal(percentile(v, 100), 50);
});

// Every percentile it reports is a duration that actually happened, so an
// operator can go and find that deploy.
test("a percentile is always one of the real values", () => {
  const v = [1, 2, 3, 4];
  for (const p of [10, 25, 50, 75, 90, 99]) {
    assert.ok(v.includes(percentile(v, p)!), `p${p} = ${percentile(v, p)} is not a real value`);
  }
});

test("a percentile of nothing is nothing", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(summarize([]), null);
  assert.equal(summarize([NaN, Infinity]), null);
});

test("a summary reports how many values it is over", () => {
  const s = summarize([10, 20, 30, 40, 1000])!;
  assert.equal(s.n, 5);
  assert.equal(s.min, 10);
  assert.equal(s.p50, 30);
  assert.equal(s.max, 1000);
  assert.equal(s.total, 1100);
});

// A user who signed up on Tuesday cannot have come back in week two. Counting
// them as churned makes retention look worst exactly when signups look best.
test("a user too new to have returned is not counted as churned", () => {
  const signup = D("2026-07-30T00:00:00Z");
  assert.equal(weekOneVerdict(signup, [], D("2026-08-01T00:00:00Z")), "too-early");
  assert.equal(weekOneVerdict(signup, [], D("2026-08-10T00:00:00Z")), "did-not-return");
});

test("activity after the first week is a return; activity inside it is not", () => {
  const signup = D("2026-07-01T00:00:00Z");
  const now = D("2026-08-01T00:00:00Z");
  assert.equal(weekOneVerdict(signup, [D("2026-07-03T00:00:00Z")], now), "did-not-return");
  assert.equal(weekOneVerdict(signup, [D("2026-07-09T00:00:00Z")], now), "returned");
  // Exactly on the boundary is inside week one, not after it.
  assert.equal(weekOneVerdict(signup, [D("2026-07-08T00:00:00Z")], now), "did-not-return");
});

test("retention is a rate over the people who could have returned", () => {
  const now = D("2026-08-01T00:00:00Z");
  const s = retentionSummary(
    [
      { signupAt: D("2026-07-01T00:00:00Z"), activity: [D("2026-07-20T00:00:00Z")] }, // returned
      { signupAt: D("2026-07-01T00:00:00Z"), activity: [] }, // did not
      { signupAt: D("2026-07-02T00:00:00Z"), activity: [D("2026-07-03T00:00:00Z")] }, // did not
      { signupAt: D("2026-07-30T00:00:00Z"), activity: [] }, // too early
    ],
    now,
  );
  assert.deepEqual(s, { returned: 1, didNotReturn: 2, tooEarly: 1, rate: 1 / 3 });
});

test("retention over nobody old enough has no rate at all", () => {
  const s = retentionSummary([{ signupAt: D("2026-07-31T00:00:00Z"), activity: [] }], D("2026-08-01T00:00:00Z"));
  assert.deepEqual(s, { returned: 0, didNotReturn: 0, tooEarly: 1, rate: null });
});

test("a funnel reports each step against the one above and against the top", () => {
  const f = funnel([
    { label: "signed up", count: 100 },
    { label: "deployed", count: 40 },
    { label: "succeeded", count: 10 },
  ]);
  assert.equal(f[0].ofPrevious, null);
  assert.equal(f[0].ofTop, 1);
  assert.equal(f[1].ofPrevious, 0.4);
  assert.equal(f[1].ofTop, 0.4);
  assert.equal(f[1].lost, 60);
  assert.equal(f[2].ofPrevious, 0.25);
  assert.equal(f[2].ofTop, 0.1);
  assert.equal(f[2].lost, 30);
});

test("an empty funnel has no rates rather than dividing by zero", () => {
  const f = funnel([
    { label: "signed up", count: 0 },
    { label: "deployed", count: 0 },
  ]);
  assert.equal(f[0].ofTop, null);
  assert.equal(f[1].ofPrevious, null);
  assert.equal(f[1].lost, 0);
});

// The queries cannot guarantee the steps nest — an app can exist with no
// recorded stages — so a step that exceeds the one above it must not report a
// negative loss.
test("a step wider than the one above it does not report negative loss", () => {
  const f = funnel([
    { label: "a", count: 5 },
    { label: "b", count: 8 },
  ]);
  assert.equal(f[1].lost, 0);
  assert.equal(f[1].ofPrevious, 1.6);
});

test("durations read as durations, and nothing reads as an em dash", () => {
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(undefined), "—");
  assert.equal(formatDuration(NaN), "—");
  assert.equal(formatDuration(-5), "—");
  assert.equal(formatDuration(0), "0ms");
  assert.equal(formatDuration(450), "450ms");
  assert.equal(formatDuration(1500), "1.5s");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(227_000), "3m 47s");
  assert.equal(formatDuration(120_000), "2m");
  assert.equal(formatDuration(5_400_000), "1h 30m");
});

test("grouping keeps the order keys first appeared in", () => {
  const g = groupBy([{ l: "b" }, { l: "a" }, { l: "b" }], (x) => x.l);
  assert.deepEqual([...g.keys()], ["b", "a"]);
  assert.equal(g.get("b")!.length, 2);
});

test("failures are classified by patterns the pipeline actually writes", () => {
  assert.equal(
    classifyFailure("Cannot tell what this app is: it declares node and python (package.json, pyproject.toml)"),
    "refused: ambiguous repo",
  );
  assert.equal(classifyFailure("the container didn't start on $PORT"), "container did not start");
  assert.equal(classifyFailure('npm start → Missing script "start"'), "run command wrong");
  assert.equal(classifyFailure("sh: 1: fastapi: not found — exit 127"), "run command wrong");
  assert.equal(classifyFailure("Build failed:\nnpm ERR! code ELIFECYCLE"), "build failed");
  assert.equal(classifyFailure("403 Forbidden: caller does not have permission"), "platform: permission");
  assert.equal(classifyFailure("Quota exceeded for resource"), "platform: quota");
  assert.equal(classifyFailure("planner timed out after 240s"), "timed out");
  assert.equal(classifyFailure("the deploy stopped reporting and never finished"), "deploy went silent");
});

// A taxonomy that quietly absorbs new failures into an existing bucket is how a
// regression goes unnoticed. Unknown text stays unknown.
test("an unrecognised failure is 'other', and a missing one is 'unrecorded'", () => {
  assert.equal(classifyFailure("the flux capacitor desynchronised"), "other");
  assert.equal(classifyFailure(null), "unrecorded");
  assert.equal(classifyFailure(""), "unrecorded");
  assert.equal(classifyFailure("   "), "unrecorded");
});
