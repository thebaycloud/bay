import { test, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * The five API routes that used to re-derive `runtimeOf(slug) === "fleet"`
 * inline, now reading `deployTargetForApp` instead — see
 * .superpowers/sdd/fleet-fixes/t13-report.md.
 *
 * Its own file for the same reason as test/delete-app-fleet.test.ts and
 * test/deploy-target.test.ts: `mock.module` is process-wide within a module
 * graph, and every route here pulls in `lib/fleet.ts` one way or another.
 *
 * `@/lib/deploy-target` is NOT mocked. The whole point of this migration is
 * that a route no longer answers "fleet or not" on its own — it asks the same
 * module the (eventually-migrated) pipeline will ask. Mocking that module out
 * would test that the route calls a function, not that the function it calls
 * actually agrees with the one fact every target decision has to trace back
 * to (`apps.runtime`, read by `lib/fleet.ts`'s `runtimeOf`). So only
 * `runtimeOf` and the storage `lib/fleet.ts` functions each route still calls
 * directly are stubbed; `deployTargetForApp`, `deployTargetFor` and the two
 * target objects are the real ones from lib/deploy-target.ts.
 */

let storedRuntime: "fleet" | "cloudrun" = "cloudrun";
let placement: { node: string; spec: { image: string } } | null = null;
let envKeys: string[] | null = ["EXISTING"];
const gcloudCalls: string[] = [];
const fleetWriteCalls: unknown[] = [];

mock.module("@/lib/session", {
  namedExports: { currentUserId: async () => "u1" },
});
mock.module("@/lib/ownership", {
  namedExports: { ownsApp: async () => true },
});
mock.module("@/lib/apps", {
  namedExports: { getAppBySlug: async () => ({ status: "live" }) },
});
mock.module("@/lib/deploys", {
  namedExports: { getDeploy: async () => null },
});
mock.module("@/lib/app-status", {
  namedExports: {
    statusFromFleet: (_slug: string, spec: { image: string }) => ({
      image: spec.image,
      ready: true,
      envKeys: [],
      processes: [],
    }),
  },
});
mock.module("@/lib/gcloud", {
  namedExports: {
    describeService: async (slug: string) => {
      gcloudCalls.push(`describeService:${slug}`);
      return { revision: "r1", image: "cloudrun-image", envKeys: ["X"], cloudsql: "", repo: "" };
    },
    setEnv: async (slug: string) => {
      gcloudCalls.push(`setEnv:${slug}`);
    },
    execCommand: async (slug: string) => {
      gcloudCalls.push(`execCommand:${slug}`);
      return { output: "ok", exitCode: 0 };
    },
    rollback: async (slug: string) => {
      gcloudCalls.push(`rollback:${slug}`);
      return "previous-revision";
    },
  },
});
// The same module deployTargetForApp itself imports `runtimeOf` from — a
// route and lib/deploy-target.ts reading a different `apps.runtime` is
// exactly the disagreement this migration closes, so this is the ONE place
// "which runtime" is decided for every test below.
mock.module("@/lib/fleet", {
  namedExports: {
    runtimeOf: async () => storedRuntime,
    placementFor: async () => placement,
    runningOnNode: async () => [],
    setPlacementEnv: async (slug: string, set: unknown, unset: unknown) => {
      fleetWriteCalls.push({ slug, set, unset });
      return envKeys;
    },
    placementEnvKeys: async () => envKeys,
  },
});

const loadedStatus = import("@/app/api/apps/[slug]/route");
const loadedEnv = import("@/app/api/apps/[slug]/env/route");
const loadedExec = import("@/app/api/apps/[slug]/exec/route");
const loadedRollback = import("@/app/api/apps/[slug]/rollback/route");
const loadedTarget = import("@/lib/deploy-target");

function reset() {
  gcloudCalls.length = 0;
  fleetWriteCalls.length = 0;
  envKeys = ["EXISTING"];
}

test("status route answers from the fleet only when deployTargetForApp says fleet", async () => {
  reset();
  storedRuntime = "fleet";
  placement = { node: "fleet-lab-1", spec: { image: "fleet-image" } };
  const { GET } = await loadedStatus;
  const res = await GET(new Request("http://x"), { params: { slug: "app1" } });
  const body = await res.json();
  assert.equal(body.image, "fleet-image", "read from the node, not Cloud Run");
  assert.deepEqual(gcloudCalls, [], "a fleet app must never be described via Cloud Run");
});

test("status route falls back to Cloud Run when deployTargetForApp says cloudrun", async () => {
  reset();
  storedRuntime = "cloudrun";
  placement = null;
  const { GET } = await loadedStatus;
  const res = await GET(new Request("http://x"), { params: { slug: "app1" } });
  const body = await res.json();
  assert.equal(body.image, "cloudrun-image");
  assert.deepEqual(gcloudCalls, ["describeService:app1"]);
});

test("env GET reads placement keys only on the fleet target", async () => {
  reset();
  storedRuntime = "fleet";
  envKeys = ["A", "B"];
  const { GET } = await loadedEnv;
  const res = await GET(new Request("http://x"), { params: { slug: "app1" } });
  const body = await res.json();
  assert.deepEqual(body.keys, ["A", "B"]);
  assert.deepEqual(gcloudCalls, []);
});

test("env GET reads the Cloud Run service on the cloudrun target", async () => {
  reset();
  storedRuntime = "cloudrun";
  const { GET } = await loadedEnv;
  const res = await GET(new Request("http://x"), { params: { slug: "app1" } });
  const body = await res.json();
  assert.deepEqual(body.keys, ["X"]);
  assert.deepEqual(gcloudCalls, ["describeService:app1"]);
});

test("env POST writes to the placement only on the fleet target", async () => {
  reset();
  storedRuntime = "fleet";
  const { POST } = await loadedEnv;
  const req = new Request("http://x", { method: "POST", body: JSON.stringify({ set: { A: "1" } }) });
  await POST(req, { params: { slug: "app1" } });
  assert.equal(fleetWriteCalls.length, 1);
  assert.deepEqual(gcloudCalls, []);
});

test("env POST calls Cloud Run's setEnv on the cloudrun target", async () => {
  reset();
  storedRuntime = "cloudrun";
  const { POST } = await loadedEnv;
  const req = new Request("http://x", { method: "POST", body: JSON.stringify({ set: { A: "1" } }) });
  await POST(req, { params: { slug: "app1" } });
  assert.equal(fleetWriteCalls.length, 0);
  assert.deepEqual(gcloudCalls, ["setEnv:app1", "describeService:app1"]);
});

test("exec is refused on the fleet target, by supports(\"exec\") — not a re-derived boolean", async () => {
  reset();
  storedRuntime = "fleet";
  const { FLEET_TARGET } = await loadedTarget;
  assert.equal(FLEET_TARGET.supports("exec"), false, "sanity: this is the fact the route must agree with");
  const { POST } = await loadedExec;
  const req = new Request("http://x", { method: "POST", body: JSON.stringify({ command: "ls" }) });
  const res = await POST(req, { params: { slug: "app1" } });
  assert.equal(res.status, 501);
  assert.deepEqual(gcloudCalls, [], "refused before touching Cloud Run");
});

test("exec runs on the cloudrun target", async () => {
  reset();
  storedRuntime = "cloudrun";
  const { POST } = await loadedExec;
  const req = new Request("http://x", { method: "POST", body: JSON.stringify({ command: "ls" }) });
  const res = await POST(req, { params: { slug: "app1" } });
  assert.equal(res.status, 200);
  assert.deepEqual(gcloudCalls, ["execCommand:app1"]);
});

test("rollback is allowed on the fleet target, and calls no gcloud", async () => {
  // The reverse of what this asserted before, and the reason is the whole point:
  // a placement used to be the only record of a version, so there was nothing to
  // go back TO and the route answered 501. `releases` now holds every version
  // with the spec that shipped.
  //
  // `gcloudCalls` staying empty is the other half. A rollback is one write to
  // `apps.desired_release`; the reconciler places the older release beside what
  // is running, waits for the node to report ready, and drains the newer one.
  // Nothing here shells out, and nothing here waits.
  reset();
  storedRuntime = "fleet";
  const { FLEET_TARGET } = await loadedTarget;
  assert.equal(FLEET_TARGET.supports("rollback"), true, "sanity: this is the fact the route must agree with");
  const { POST } = await loadedRollback;
  const res = await POST(new Request("http://x"), { params: { slug: "app1" } });
  assert.notEqual(res.status, 501);
  assert.deepEqual(gcloudCalls, []);
});

test("rollback is refused for a static app, which has no versions", async () => {
  // The cloudrun target is what a static app resolves to — it is served from a
  // bucket by the shared static server — and `rollback` left that capability set
  // with the lane it belonged to. So this is still a 501, for a reason that is
  // now about the app rather than about the mechanism being unbuilt.
  reset();
  storedRuntime = "cloudrun";
  const { POST } = await loadedRollback;
  const res = await POST(new Request("http://x"), { params: { slug: "app1" } });
  assert.equal(res.status, 501);
  assert.deepEqual(gcloudCalls, []);
});

test("every route's decision traces back to the one deployTargetFor mapping — the property that stops a route and the (future-migrated) pipeline from disagreeing", async () => {
  const { deployTargetFor } = await loadedTarget;
  for (const kind of ["fleet", "cloudrun"] as const) {
    reset();
    storedRuntime = kind;
    placement = kind === "fleet" ? { node: "n1", spec: { image: "i" } } : null;
    const target = deployTargetFor(kind);

    const { POST: execPost } = await loadedExec;
    const execRes = await execPost(
      new Request("http://x", { method: "POST", body: JSON.stringify({ command: "ls" }) }),
      { params: { slug: "app1" } },
    );
    assert.equal(execRes.status === 501, !target.supports("exec"), `exec route vs supports("exec") for ${kind}`);

    const { POST: rollbackPost } = await loadedRollback;
    const rollbackRes = await rollbackPost(new Request("http://x"), { params: { slug: "app1" } });
    assert.equal(
      rollbackRes.status === 501,
      !target.supports("rollback"),
      `rollback route vs supports("rollback") for ${kind}`,
    );
  }
});
