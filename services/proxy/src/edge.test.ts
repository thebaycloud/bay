import { test } from "node:test";
import assert from "node:assert/strict";
import { decideEdge, STALE_AFTER_MS, type EdgeInput } from "./edge";

const NOW = 1_800_000_000_000;
const at = (msAgo: number) => NOW - msAgo;

function edge(over: Partial<EdgeInput> = {}) {
  return decideEdge({
    buildLive: false, status: "deploying",
    deploy: { status: "building", error: null, updatedAt: at(5_000) },
    now: NOW,
    ...over,
  });
}

test("a landed build is served, whatever the status says", () => {
  assert.deepEqual(edge({ status: "live", buildLive: true }), { serve: "build" });
});

test("a redeploy keeps serving the release it is replacing", () => {
  // A redeploy flips status back to 'deploying'. Visitors must go on getting the
  // version that works for the whole build — this is the case the preview tunnel
  // used to take over, pointing them at a developer's laptop instead.
  assert.deepEqual(edge({ status: "deploying", buildLive: true }), { serve: "build" });
});

test("a failed redeploy still serves the release that worked", () => {
  // The failure belongs to the owner, not to the visitors of an app that is up.
  assert.deepEqual(
    edge({ status: "failed", buildLive: true, deploy: { status: "failed", error: "boom", updatedAt: at(1_000) } }),
    { serve: "build" },
  );
});

test("a deploy still making progress says so", () => {
  assert.deepEqual(edge({ deploy: { status: "building", error: null, updatedAt: at(60_000) } }),
    { page: "building" });
  // Long-running but alive: a cold monorepo build genuinely takes minutes, and
  // the clock is last-progress, not start.
  assert.deepEqual(edge({ deploy: { status: "building", error: null, updatedAt: at(STALE_AFTER_MS - 1000) } }),
    { page: "building" });
});

test("a deploy that stopped saying anything stops claiming to be busy", () => {
  // This is the case that mattered: a job killed mid-build leaves status
  // 'deploying' with nothing to serve, and the old edge answered 200 "Deploying…"
  // forever. Monitoring reads that as healthy; an agent reads it as shipped.
  const stalled = edge({ deploy: { status: "building", error: null, updatedAt: at(STALE_AFTER_MS + 1000) } });
  assert.deepEqual(stalled, { page: "stalled" });
});

test("a failed deploy says it failed, and why", () => {
  const reason = "Prepare failed:\nnpm error 404 Not Found - GET .../nope";
  assert.deepEqual(edge({ deploy: { status: "failed", error: reason, updatedAt: at(1000) } }),
    { page: "failed", reason });
  // The app row alone is enough, even with no reason recorded.
  assert.deepEqual(edge({ status: "failed", deploy: null }), { page: "failed", reason: null });
});

test("a failed redeploy never takes down the release that is already live", () => {
  // apps.run_url survives a failed redeploy on purpose. The previous build stays
  // served; a failure page here would take a working app off the air.
  assert.deepEqual(edge({ status: "failed", buildLive: true, deploy: { status: "failed", error: "boom", updatedAt: at(1000) } }),
    { serve: "build" });
});

test("marked live with nothing to serve is stalled, not 'hang tight'", () => {
  // status='live' but no run_url: the deploy said it finished and left nothing
  // behind. "Your app is going live" would be a promise with no end.
  assert.deepEqual(edge({ status: "live", buildLive: false, deploy: { status: "live", error: null, updatedAt: at(1000) } }),
    { page: "stalled" });
});

test("an app with no web process is not a broken app", () => {
  // The shape this exists for: an app with one `bot` process and no `web`.
  //
  // Checked against the live project on 5 Aug, in two passes, because the first
  // pass reached the wrong answer and the way it went wrong is worth keeping.
  //
  // Pass one looked at the Cloud Run SERVICE named hdhxq and found revision
  // hdhxq-00004-nwg stuck on HealthCheckContainerError, latestReady None, no
  // url, no traffic — and its logs from 2 Aug 20:42 saying "[supersonic-run]
  // FATAL: no run command for this app". No Cloud Run Job either. Every one of
  // those facts is true, and together they look exactly like a dead app.
  //
  // They are a dead ATTEMPT. A worker does not run as a service or as a job: it
  // runs as a Cloud Run WORKER POOL, which `gcloud run services list` and
  // `jobs list` do not show, so looking in both and finding nothing reads as
  // "nothing is running" when the thing is simply somewhere else. hdhxq-bot was
  // created at 20:59 that same evening — seventeen minutes after the failed
  // service revision — is Ready=True on revision hdhxq-bot-00003-4jq, and its
  // own logs record `telegram.ext.Application - INFO - Application started`.
  // It has logged nothing for a day, which is what an idle polling bot does and
  // is not evidence of anything.
  //
  // So hdhxq IS worker-only and IS running, the 503 was ours, and has_web=false
  // is right for it. The failed service revision is leftover from the runner
  // lane that same day and is what made the app look broken to anyone checking.
  //
  // The lesson that survives: "no service and no job" is not "not running" on
  // this platform, and any future check written here must look at worker pools
  // too.
  // It went live correctly,
  // there is no run_url because there is no HTTP service to point at, and the
  // edge called that "This deploy stopped" for two days on a customer's URL.
  // Both readings of apps.status reach it — the row could say 'live' with a
  // finished deploy, or still say 'deploying' behind a deploy nobody updated —
  // so neither is allowed to gate the answer.
  assert.deepEqual(
    edge({ status: "live", buildLive: false, hasWeb: false, deploy: { status: "live", error: null, updatedAt: at(1000) } }),
    { page: "noweb" });
  assert.deepEqual(
    edge({ status: "deploying", buildLive: false, hasWeb: false, deploy: { status: "building", error: null, updatedAt: at(STALE_AFTER_MS + 1000) } }),
    { page: "noweb" });
});

test("a worker-only app whose redeploy FAILED still says it failed", () => {
  // The fail-open this fix could so easily have been. has_web=false is written
  // by markAppLive, i.e. by the last GOOD deploy, and it outlives a later
  // failure. Answering "nothing is wrong, it runs as a worker" to the owner of
  // a bot that stopped building would delete the only signal they had.
  assert.deepEqual(
    edge({ status: "failed", buildLive: false, hasWeb: false, deploy: { status: "failed", error: "boom", updatedAt: at(1000) } }),
    { page: "failed", reason: "boom" });
  // The deploys row alone is enough, exactly as it is for a web app.
  assert.deepEqual(
    edge({ status: "live", buildLive: false, hasWeb: false, deploy: { status: "failed", error: "boom", updatedAt: at(1000) } }),
    { page: "failed", reason: "boom" });
});

test("an app whose row predates the has_web column is NOT called a worker", () => {
  // The other fail-open. On a control plane running ahead of the migration
  // has_web arrives `undefined`, and `!hasWeb` would tell every stalled and
  // every building app in the platform that nothing is wrong. Only an explicit
  // false counts.
  assert.deepEqual(
    edge({ status: "live", buildLive: false, hasWeb: undefined, deploy: { status: "live", error: null, updatedAt: at(1000) } }),
    { page: "stalled" });
  assert.deepEqual(
    edge({ status: "live", buildLive: false, hasWeb: true, deploy: { status: "live", error: null, updatedAt: at(1000) } }),
    { page: "stalled" });
});

test("an app from before the deploys table keeps its old behaviour", () => {
  // No row to measure staleness against. Declaring such an app dead on the
  // strength of a missing record would be worse than the bug being fixed.
  assert.deepEqual(edge({ deploy: null }), { page: "building" });
  assert.deepEqual(edge({ deploy: { status: "building", error: null, updatedAt: null } }), { page: "building" });
});

test("the owner's reading outranks every page this function can answer with", () => {
  // The four states a reading exists to express include the three that produce
  // a page of their own here — building, failed, stalled — plus the worker-only
  // app that produces a 404. Decided after the edge, as it was, the x-ray was
  // reachable for none of them: the owner and their agent got HTML and a status
  // chosen for a visitor, and `open` could never be false on a served reading.
  assert.deepEqual(edge({ xrayForOwner: true }), { serve: "xray" });
  assert.deepEqual(
    edge({ xrayForOwner: true, status: "failed", deploy: { status: "failed", error: "boom", updatedAt: at(1000) } }),
    { serve: "xray" });
  assert.deepEqual(
    edge({ xrayForOwner: true, deploy: { status: "building", error: null, updatedAt: at(STALE_AFTER_MS + 1000) } }),
    { serve: "xray" });
  assert.deepEqual(
    edge({ xrayForOwner: true, status: "live", hasWeb: false, deploy: { status: "live", error: null, updatedAt: at(1000) } }),
    { serve: "xray" });
});

test("nothing about who may see a reading is decided here", () => {
  // Anyone who is not the owner is not carrying this flag, and the URL goes on
  // being an ordinary request to the app — which is what stops a visitor
  // learning that /_xray means anything at all.
  assert.deepEqual(edge({ xrayForOwner: false, buildLive: true }), { serve: "build" });
  assert.deepEqual(edge({ xrayForOwner: false }), { page: "building" });
});
