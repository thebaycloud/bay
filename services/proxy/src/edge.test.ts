import { test } from "node:test";
import assert from "node:assert/strict";
import { decideEdge, STALE_AFTER_MS, type EdgeInput } from "./edge";

const NOW = 1_800_000_000_000;
const at = (msAgo: number) => NOW - msAgo;

function edge(over: Partial<EdgeInput> = {}) {
  return decideEdge({
    buildLive: false, tunnelUp: false, status: "deploying",
    deploy: { status: "building", error: null, updatedAt: at(5_000) },
    now: NOW,
    ...over,
  });
}

test("a landed build outranks a preview tunnel of it", () => {
  // The tunnel is the live preview of a deploy in flight, and `--wait` holds it
  // open for the whole build. Once the build has landed, visitors must get the
  // build — not whatever the developer's laptop is still serving.
  assert.deepEqual(edge({ status: "live", buildLive: true, tunnelUp: true }), { serve: "build" });
  assert.deepEqual(edge({ status: "live", buildLive: true, tunnelUp: false }), { serve: "build" });
});

test("during a deploy the tunnel still wins — that is what it is for", () => {
  // A redeploy flips status back to 'deploying', which is exactly the window in
  // which the preview should show the code being deployed rather than the
  // previous release.
  assert.deepEqual(edge({ status: "deploying", buildLive: true, tunnelUp: true }), { serve: "tunnel" });
  assert.deepEqual(edge({ status: "deploying", buildLive: true, tunnelUp: false }), { serve: "build" });
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

test("an app from before the deploys table keeps its old behaviour", () => {
  // No row to measure staleness against. Declaring such an app dead on the
  // strength of a missing record would be worse than the bug being fixed.
  assert.deepEqual(edge({ deploy: null }), { page: "building" });
  assert.deepEqual(edge({ deploy: { status: "building", error: null, updatedAt: null } }), { page: "building" });
});
