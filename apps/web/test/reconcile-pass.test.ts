import { test } from "node:test";
import assert from "node:assert/strict";
import { pass } from "../lib/reconcile";

/**
 * A fake Postgres that answers by looking at the SQL.
 *
 * `pass` is the heart of the fleet and nothing exercised it: the pure pieces
 * around it — `hasQuorum`, `nodeHealth`, `planPlacements` — each had tests, and
 * the function that wires them together had none. So "the planner spreads by
 * load" was proven while "the pass computes load correctly" was not, and those
 * are different claims.
 */
function fakeClient(rows: Record<string, unknown>[], nodes: { name: string; lastSeen: number; drain?: boolean }[]) {
  const applied: { sql: string; values: unknown[] }[] = [];
  return {
    applied,
    query: async (text: string, values: unknown[] = []) => {
      if (text.includes("FROM fleet_nodes")) {
        // The real query is `extract(epoch from last_seen) * 1000`, so this column
        // arrives in milliseconds already.
        return { rows: nodes.map((n) => ({ name: n.name, drain: n.drain ?? false, last_seen: n.lastSeen })) };
      }
      if (text.includes("FROM apps a")) return { rows };
      applied.push({ sql: text, values });
      return { rows: [] };
    },
  };
}

const NOW = 1_000_000;
const FRESH = NOW - 1_000;

/**
 * One row of the pass's own join: an app, and one of its placements.
 *
 * `pinned` is a DERIVED column in the real query — `has_data OR (spec ?
 * 'dataDir')` — so the fake derives it too. Returning the raw inputs and
 * forgetting the derivation would make every pinning test pass against a pass
 * that had stopped reading the column at all.
 */
const row = (o: Partial<Record<string, unknown>> & { slug: string }) => ({
  desired_release: 7,
  has_data: false,
  desired_replicas: 1,
  instance: null,
  node: null,
  release_id: null,
  state: null,
  lease_until: null,
  ...o,
}) as Record<string, unknown>;

/** The same row, with the query's derived `pinned` column computed. */
const joined = (o: Partial<Record<string, unknown>> & { slug: string }) => {
  const r = row(o);
  return { ...r, pinned: Boolean(r.has_data) };
};

test("a pass restricted to one app still measures the load of the whole fleet", async () => {
  // THE REASON THE FILTER IS NOT IN THE QUERY. A deploy converges one app
  // immediately rather than waiting up to a minute for the tick, and it has to
  // do it through this same function — but "which node is least loaded" is a
  // fact about every placement on the fleet, not about the app being placed.
  //
  // Filter the SQL and n2 looks empty; filter the loop and n2 is seen carrying
  // three apps, so the new placement goes to n1. That is the whole difference,
  // and it is invisible unless the other apps are in the rows.
  const rows = [
    joined({ slug: "mine", desired_release: 7 }),
    joined({ slug: "other1", instance: 0, node: "n2", release_id: 1, state: "ready", lease_until: NOW + 60_000 }),
    joined({ slug: "other2", instance: 0, node: "n2", release_id: 1, state: "ready", lease_until: NOW + 60_000 }),
    joined({ slug: "other3", instance: 0, node: "n2", release_id: 1, state: "ready", lease_until: NOW + 60_000 }),
  ];
  const c = fakeClient(rows, [{ name: "n1", lastSeen: FRESH }, { name: "n2", lastSeen: FRESH }]);

  const result = await pass(c, NOW, "mine");

  assert.deepEqual(
    result.steps,
    [{ kind: "place", slug: "mine", instance: 0, node: "n1", release: 7 }],
    "the emptier node, which is only visible because the other apps were counted",
  );
});

test("a restricted pass plans for that app and no other", async () => {
  // `other` is one instance short of what it wants, and would be placed by an
  // unrestricted pass. A deploy of `mine` must not carry someone else's app
  // along with it — the deploy would then report success or failure for work it
  // never intended to do.
  const rows = [
    joined({ slug: "mine", desired_release: 7 }),
    joined({ slug: "other", desired_release: 9 }),
  ];
  const c = fakeClient(rows, [{ name: "n1", lastSeen: FRESH }]);

  const result = await pass(c, NOW, "mine");

  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].slug, "mine");
});

test("an unrestricted pass still plans for everything", async () => {
  // The restriction is an argument, not a change of behaviour: the scheduled
  // pass passes nothing and must keep converging the whole fleet.
  const rows = [
    joined({ slug: "mine", desired_release: 7 }),
    joined({ slug: "other", desired_release: 9 }),
  ];
  const c = fakeClient(rows, [{ name: "n1", lastSeen: FRESH }, { name: "n2", lastSeen: FRESH }]);

  const result = await pass(c, NOW);

  assert.deepEqual(result.steps.map((s) => s.slug).sort(), ["mine", "other"]);
});

test("no quorum holds an expired placement rather than moving it", async () => {
  // The wiring of the safety rule, as against the rule itself: `hasQuorum` is
  // tested on its own, and this is the claim that `pass` consults it and reports
  // what it declined to do. `held` and `steps: []` together are the difference
  // between a quiet fleet and a blind one.
  const rows = [
    joined({ slug: "mine", instance: 0, node: "n2", release_id: 7, state: "ready", lease_until: NOW - 1 }),
  ];
  const c = fakeClient(rows, [
    { name: "n1", lastSeen: FRESH },
    { name: "n2", lastSeen: NOW - 999_000 },
    { name: "n3", lastSeen: NOW - 999_000 },
  ]);

  const result = await pass(c, NOW);

  assert.equal(result.quorum, false);
  assert.deepEqual(result.steps, []);
  assert.equal(result.held, 1);
});

test("an app with data on a node is pinned to it, and never evicted", async () => {
  // §8: "Volumes pin. /srv/apps/<slug>/data is bind-mounted from a disk nothing
  // replicates, which conflicts directly with the reconciler wanting to move
  // apps. The placement model must be able to express 'this cannot move'."
  //
  // It expressed it and nothing ever set it. `pinned` was derived from
  // `spec ? 'dataDir'`, and no code path has ever written dataDir into a spec —
  // the agent computes that directory locally and keeps it off the wire, so the
  // control plane could not tell who had data. Every app was movable, including
  // the two carrying SQLite databases on fleet-lab-2.
  //
  // The pin is now the NODE's observation: it is the only thing that can see
  // whether the directory has anything in it.
  const rows = [
    joined({ slug: "hasdata", instance: 0, node: "n2", release_id: 7, state: "ready", lease_until: NOW - 1, has_data: true }),
  ];
  const c = fakeClient(rows, [
    { name: "n1", lastSeen: FRESH },
    { name: "n2", lastSeen: NOW - 999_000 },
    { name: "n3", lastSeen: FRESH },
  ]);

  const result = await pass(c, NOW);

  // Quorum holds — two of three nodes are reporting — and the lease has expired
  // on a node nobody can hear, which is exactly the shape that gets evicted. It
  // must not be, because the data does not follow.
  assert.equal(result.quorum, true);
  assert.deepEqual(result.steps, [], "an app with data was moved away from its data");
});

test("an app without data is still evicted from a node that cannot be heard", async () => {
  // The control: without this, the test above would pass just as well against a
  // planner that had stopped evicting anything at all.
  const rows = [
    joined({ slug: "nodata", instance: 0, node: "n2", release_id: 7, state: "ready", lease_until: NOW - 1 }),
  ];
  const c = fakeClient(rows, [
    { name: "n1", lastSeen: FRESH },
    { name: "n2", lastSeen: NOW - 999_000 },
    { name: "n3", lastSeen: FRESH },
  ]);

  const result = await pass(c, NOW);
  assert.deepEqual(result.steps, [{ kind: "evict", slug: "nodata", instance: 0 }]);
});

test("a pass moves at most one app for balance, however lopsided the fleet", async () => {
  // THE DEFECT THIS EXISTS FOR, watched in production. A rebuilt node registered
  // empty beside one carrying nineteen, and every one of those nineteen apps
  // decided to move in the same pass — because each is planned separately and
  // they all see the same load snapshot, taken once at the top of the pass.
  //
  // The fleet went 13/19/0 to 13/19/32 and then swung back. A rebalancer acting
  // on a snapshot it is invalidating is not converging, it is ringing.
  const rows = [
    joined({ slug: "a", instance: 0, node: "n2", release_id: 7, state: "ready", lease_until: NOW + 60_000 }),
    joined({ slug: "b", instance: 0, node: "n2", release_id: 7, state: "ready", lease_until: NOW + 60_000 }),
    joined({ slug: "c", instance: 0, node: "n2", release_id: 7, state: "ready", lease_until: NOW + 60_000 }),
    joined({ slug: "d", instance: 0, node: "n2", release_id: 7, state: "ready", lease_until: NOW + 60_000 }),
  ];
  const c = fakeClient(rows, [{ name: "n1", lastSeen: FRESH }, { name: "n2", lastSeen: FRESH }]);

  const result = await pass(c, NOW);

  const moves = result.steps.filter((s) => s.kind === "place");
  assert.equal(moves.length, 1, `one move per pass, got ${JSON.stringify(result.steps)}`);
});

test("the one-per-pass budget does not hold up work that is not a rebalance", async () => {
  // The budget must not become a general throttle. An app that is short an
  // instance is the fleet not being what it was asked for, and every one of those
  // is planned on the same pass as always.
  const rows = [
    joined({ slug: "a" }),
    joined({ slug: "b" }),
    joined({ slug: "c" }),
  ];
  const c = fakeClient(rows, [{ name: "n1", lastSeen: FRESH }, { name: "n2", lastSeen: FRESH }, { name: "n3", lastSeen: FRESH }]);

  const result = await pass(c, NOW);
  assert.equal(result.steps.length, 3, "three apps with nothing placed should all be placed");
});
