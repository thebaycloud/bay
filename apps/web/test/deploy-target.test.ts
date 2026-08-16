import { test, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * The deploy-target abstraction: one named thing answering "where does this
 * app run", with both current targets behind it. Two of `supports`'s four
 * capabilities are wired to a real call site now — `domainMapping` and
 * `autoRollbackOnFailure`, both in deploy-pipeline.ts (see
 * lib/deploy-target.ts's own doc comment) — but every fact this module states
 * is pinned here regardless, so a caller migrating onto it has a target that
 * was already proven correct rather than a fresh guess.
 *
 * Its own file, `mock.module`'d, for the same reason as
 * test/delete-app-fleet.test.ts: `mock.module` is process-wide within a
 * module graph, and `deployTargetForApp` pulls in `lib/fleet.ts`'s
 * `runtimeOf`, which touches a real pool everywhere else in the app.
 */

let queriedSlug: string | null = null;
let storedRuntime: string | null = "fleet";

mock.module("@/lib/db", {
  namedExports: {
    getPool: () => ({
      query: async (_sql: string, params: unknown[]) => {
        queriedSlug = params[0] as string;
        return { rows: storedRuntime === null ? [] : [{ runtime: storedRuntime }] };
      },
    }),
  },
});

const loadedTarget = import("../lib/deploy-target");
const loadedDbAddress = import("../lib/db-address");

test("the two targets are the only two, and they answer every fact asked of them", async () => {
  const { CLOUD_RUN_TARGET, FLEET_TARGET } = await loadedTarget;
  assert.equal(CLOUD_RUN_TARGET.kind, "cloudrun");
  assert.equal(FLEET_TARGET.kind, "fleet");
  assert.notEqual(CLOUD_RUN_TARGET.kind, FLEET_TARGET.kind);
});

test("databaseAddress matches lib/db-address.ts exactly — one fact, not a second copy of it", async () => {
  const { CLOUD_RUN_TARGET, FLEET_TARGET } = await loadedTarget;
  const { CLOUD_RUN_DB, FLEET_DB } = await loadedDbAddress;
  assert.deepEqual(CLOUD_RUN_TARGET.databaseAddress, CLOUD_RUN_DB);
  assert.deepEqual(FLEET_TARGET.databaseAddress, FLEET_DB);
});

test("only the fleet owns its own process lifecycle", async () => {
  const { CLOUD_RUN_TARGET, FLEET_TARGET } = await loadedTarget;
  assert.equal(CLOUD_RUN_TARGET.ownsProcessLifecycle, false);
  assert.equal(FLEET_TARGET.ownsProcessLifecycle, true);
});

test("both targets have release as a stage with its own deploy_stages row", async () => {
  // Fleet caught up: deploy-pipeline.ts now writes a real `release` row for a
  // fleet deploy (:3754) the same way it always has for Cloud Run's (:2757).
  // Kept as its own assertion rather than deleted now that the two agree —
  // see the field's own doc comment for why the fact is still worth pinning.
  const { CLOUD_RUN_TARGET, FLEET_TARGET } = await loadedTarget;
  assert.equal(CLOUD_RUN_TARGET.hasReleaseStage, true);
  assert.equal(FLEET_TARGET.hasReleaseStage, true);
});

test("the cloud run target keeps only what still guards a static app", async () => {
  const { CLOUD_RUN_TARGET } = await loadedTarget;
  for (const capability of ["exec", "domainMapping", "autoRollbackOnFailure"] as const) {
    assert.equal(CLOUD_RUN_TARGET.supports(capability), true, capability);
  }
  // `rollback` LEFT this set, and the removal is the same change as the addition
  // below. Cloud Run's rollback walked `gcloud run revisions list` and split
  // traffic back to the last Ready one; that lane is deleted, and the only apps
  // still on this target are static — files in a bucket, with no revisions.
  assert.equal(CLOUD_RUN_TARGET.supports("rollback"), false);
});

test("the fleet supports rollback, and still none of the other three", async () => {
  // ROLLBACK IS THE FIRST ENTRY THIS SET HAS EVER HAD, and what changed is not
  // the fleet's ambition — it is that a placement stopped being the only record
  // of a version. `releases` holds every one with the spec that shipped, so
  // rolling back is `apps.desired_release = previous` and the reconciler
  // converges through the same function a deploy uses.
  //
  // The other three remain false, and each is a fact rather than a TODO: `exec`
  // has no isolated per-app execution on a node, `domainMapping` names a Cloud
  // Run service, and `autoRollbackOnFailure` is Cloud Run's traffic-split undo —
  // a different mechanism from this one, since a failed fleet deploy is handled
  // by restoring the previous placement rather than by walking a history.
  const { FLEET_TARGET } = await loadedTarget;
  assert.equal(FLEET_TARGET.supports("rollback"), true);
  for (const capability of ["exec", "domainMapping", "autoRollbackOnFailure"] as const) {
    assert.equal(FLEET_TARGET.supports(capability), false, capability);
  }
});

test("deployTargetFor is a pure lookup, not a fresh object per call", async () => {
  const { deployTargetFor, CLOUD_RUN_TARGET, FLEET_TARGET } = await loadedTarget;
  assert.equal(deployTargetFor("fleet"), FLEET_TARGET);
  assert.equal(deployTargetFor("cloudrun"), CLOUD_RUN_TARGET);
});

test("deployTargetForApp reads the same column runtimeOf does, for the same slug", async () => {
  const { deployTargetForApp, FLEET_TARGET } = await loadedTarget;
  storedRuntime = "fleet";
  const target = await deployTargetForApp("t1ppt");
  assert.equal(target, FLEET_TARGET);
  assert.equal(queriedSlug, "t1ppt");
});

test("an app with no runtime row reads as cloudrun — the same default runtimeOf documents", async () => {
  const { deployTargetForApp, CLOUD_RUN_TARGET } = await loadedTarget;
  storedRuntime = null;
  const target = await deployTargetForApp("unknown-app");
  assert.equal(target, CLOUD_RUN_TARGET);
});
