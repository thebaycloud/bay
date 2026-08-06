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

mock.module("@/lib/gcloud", {
  namedExports: { deleteApp: async () => {} },
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
