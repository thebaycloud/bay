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

/** One row of the pass's own join: an app, and one of its placements. */
const row = (o: Partial<Record<string, unknown>> & { slug: string }) => ({
  desired_release: 7,
  desired_replicas: 1,
  instance: null,
  node: null,
  release_id: null,
  state: null,
  lease_until: null,
  pinned: false,
  ...o,
});

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
    row({ slug: "mine", desired_release: 7 }),
    row({ slug: "other1", instance: 0, node: "n2", release_id: 1, state: "ready", lease_until: NOW + 60_000 }),
    row({ slug: "other2", instance: 0, node: "n2", release_id: 1, state: "ready", lease_until: NOW + 60_000 }),
    row({ slug: "other3", instance: 0, node: "n2", release_id: 1, state: "ready", lease_until: NOW + 60_000 }),
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
    row({ slug: "mine", desired_release: 7 }),
    row({ slug: "other", desired_release: 9 }),
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
    row({ slug: "mine", desired_release: 7 }),
    row({ slug: "other", desired_release: 9 }),
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
    row({ slug: "mine", instance: 0, node: "n2", release_id: 7, state: "ready", lease_until: NOW - 1 }),
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
