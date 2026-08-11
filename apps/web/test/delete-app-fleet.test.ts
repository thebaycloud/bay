import { test, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * Deleting an app and its fleet placement.
 *
 * Its own file because `mock.module` is process-wide within a module graph —
 * see test/admin-fleet-route.test.ts for the same reasoning.
 *
 * The chain this closes is in docs/research/orphaned-placement.md: placements
 * are keyed on (slug, node), not slug, so `placeApp` upserting its own pair
 * never touches a row left on another node. The delete route called nothing
 * that did. A slug freed here is five characters and, per lib/gcloud.ts's own
 * comment about database and image reuse, WILL be re-issued — and the orphan
 * hands the next tenant on that slug's node the previous tenant's spec.
 */

let unplaceCalls: string[] = [];
let unplaceShouldThrow = false;
/** Slugs whose in-flight deploys were stopped, in the order it happened. */
let supersedeCalls: string[] = [];
let supersedeShouldThrow = false;
/** Everything the route did, in order, so "before" can be asserted as before. */
let order: string[] = [];

mock.module("@/lib/gcloud", {
  namedExports: { deleteApp: async () => { order.push("deleteApp"); } },
});

mock.module("@/lib/deploy-runs", {
  namedExports: {
    supersedeRunsFor: async (slug: string) => {
      order.push("supersede");
      supersedeCalls.push(slug);
      if (supersedeShouldThrow) throw new Error("cancel API unreachable");
    },
  },
});

mock.module("@/lib/apps", {
  namedExports: { getAppBySlug: async () => ({ owner_id: "u1" }) },
});

mock.module("@/lib/db", {
  namedExports: { getPool: () => ({ query: async () => ({ rows: [] }) }) },
});

mock.module("@/lib/deploys", {
  namedExports: {
    deleteDeploy: async () => {},
    deployOwner: async () => null,
  },
});

mock.module("@/lib/session", {
  namedExports: { currentUserId: async () => "u1" },
});

mock.module("@/lib/ownership", {
  namedExports: { ownsApp: async () => true },
});

mock.module("@/lib/fleet", {
  namedExports: {
    unplaceApp: async (slug: string) => {
      unplaceCalls.push(slug);
      if (unplaceShouldThrow) throw new Error("db unreachable");
    },
  },
});

const loaded = import("@/app/api/apps/[slug]/delete/route");

async function post(slug: string) {
  const { POST } = await loaded;
  return POST(new Request("http://x"), { params: { slug } });
}

test("deleting an app clears its fleet placement", async () => {
  unplaceCalls = [];
  unplaceShouldThrow = false;

  const res = await post("myapp");

  assert.equal(res.status, 200);
  // The whole fix in one assertion: the delete path now calls the function
  // that deletes a slug's placement across every node, so no row survives
  // the app it belonged to for a future slug reuse to hand to a stranger.
  assert.deepEqual(unplaceCalls, ["myapp"]);
});

test("deleting an app that was never on the fleet still succeeds", async () => {
  unplaceCalls = [];
  unplaceShouldThrow = false;

  // unplaceApp's own DELETE matches zero rows for a slug that was never
  // placed and raises nothing — there is no separate "not found" path to
  // wire up. What matters here is the delete finishing all the same.
  const res = await post("never-placed");

  assert.equal(res.status, 200);
  assert.deepEqual(unplaceCalls, ["never-placed"]);
});

test("a broken placement lookup does not stop the app from being deleted", async () => {
  unplaceCalls = [];
  unplaceShouldThrow = true;

  // If unplaceApp throws (e.g. the DB is briefly unreachable), the user still
  // asked for their app to be gone. Losing the whole delete over the one
  // best-effort cleanup step would be a worse outcome than a placement row
  // that lingers a little longer.
  const res = await post("myapp");

  assert.equal(res.status, 200);
  assert.deepEqual(unplaceCalls, ["myapp"]);
});

/* -------------------------------------------------------------------------- */
/* The deploy that is running while you delete                                */
/* -------------------------------------------------------------------------- */

test("deleting an app stops the deploy that is running for it", async () => {
  supersedeCalls = [];
  supersedeShouldThrow = false;
  order = [];

  const res = await post("myapp");

  assert.equal(res.status, 200);
  // Nothing used to stop it. The delete tore down the app and left the build
  // running against a slug that no longer existed — free to recreate, seconds
  // later, the very resources this call had just deleted. It also left the run
  // row standing, which counts against the owner's concurrent-deploy cap for an
  // hour and holds the app's secrets until the six-hour sweep, even though
  // bounding exactly that is what deleting the row is for.
  assert.deepEqual(supersedeCalls, ["myapp"]);
});

test("the running deploy is stopped BEFORE the app is torn down", async () => {
  supersedeCalls = [];
  supersedeShouldThrow = false;
  order = [];

  await post("myapp");

  // Order is the whole point, not tidiness. Tear the app down first and the
  // still-running deploy spends the next two minutes recreating a service,
  // a database and an image for an app the user has been told is gone — which
  // is one way to manufacture the orphans bench/cleanup.ts was written to hunt.
  assert.deepEqual(order.slice(0, 2), ["supersede", "deleteApp"]);
});

test("a deploy that cannot be cancelled does not stop the app being deleted", async () => {
  supersedeCalls = [];
  supersedeShouldThrow = true;
  unplaceCalls = [];
  unplaceShouldThrow = false;
  order = [];

  // Same rule as every other cleanup step here: the user asked for their app to
  // be gone. A build that will not cancel is a smaller problem than a delete
  // that returns 500 for everything it already did.
  const res = await post("myapp");

  assert.equal(res.status, 200);
  assert.deepEqual(unplaceCalls, ["myapp"]);
});
