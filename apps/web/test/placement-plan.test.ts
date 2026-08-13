import { test } from "node:test";
import assert from "node:assert/strict";
import { planPlacements, type Desired, type Placed, type NodeHealth, type Step } from "@/lib/placement-plan";

const NOW = 1_000_000_000_000;
const alive: NodeHealth[] = [
  { name: "n1", healthy: true, load: 0 }, { name: "n2", healthy: true, load: 0 }, { name: "n3", healthy: true, load: 0 },
];
/** The same three nodes, carrying the loads given. */
const loaded = (...loads: number[]): NodeHealth[] =>
  alive.map((n, i) => ({ ...n, load: loads[i] ?? 0 }));
const desired = (over: Partial<Desired> = {}): Desired =>
  ({ slug: "lilna", release: 7, replicas: 1, pinnedTo: null, ...over });
const placed = (over: Partial<Placed> = {}): Placed =>
  ({ instance: 0, node: "n1", release: 7, state: "ready", leaseUntil: NOW + 60_000, ...over });

const kinds = (steps: Step[]) => steps.map((s) => s.kind).sort();

/** Narrow to a `place` step, asserting the kind on the way — a `drain` has no node. */
function place(steps: Step[], i = 0) {
  const s = steps[i];
  assert.equal(s?.kind, "place");
  if (s?.kind !== "place") throw new Error("unreachable");
  return s;
}

test("an app already running what it should is left alone", () => {
  const steps = planPlacements(desired(), [placed()], alive, NOW, true);
  assert.deepEqual(steps, []);
});

test("an app with no placement gets one", () => {
  const steps = planPlacements(desired(), [], alive, NOW, true);
  assert.equal(steps.length, 1);
  const p = place(steps);
  assert.equal(p.release, 7);
  assert.ok(alive.some((n) => n.name === p.node), "it must be placed on a live node");
});

test("asking for two instances of a one-instance app adds one, and does not disturb the other", () => {
  const steps = planPlacements(desired({ replicas: 2 }), [placed()], alive, NOW, true);
  assert.deepEqual(kinds(steps), ["place"]);
  assert.notEqual(place(steps).instance, 0, "the new instance must not collide with the running one");
});

// Rolling, and the order is the whole point: the new instance comes up BESIDE
// the old one. Removing first is stop-then-start, which is the downtime this
// model exists to end.
test("a new release is placed beside the old one, which keeps serving", () => {
  const steps = planPlacements(desired({ release: 8 }), [placed({ release: 7 })], alive, NOW, true);
  assert.deepEqual(kinds(steps), ["place"]);
  assert.equal(place(steps).release, 8);
  assert.ok(!steps.some((s) => s.kind === "remove"), "the old instance must not be touched until the new one is ready");
});

test("once the new release is ready the old one drains, and only then goes", () => {
  const mid = [placed({ instance: 0, release: 7, state: "ready" }),
               placed({ instance: 1, release: 8, state: "ready", node: "n2" })];
  const draining = planPlacements(desired({ release: 8 }), mid, alive, NOW, true);
  assert.deepEqual(kinds(draining), ["drain"]);
  assert.equal(draining[0].instance, 0);

  const gone = planPlacements(desired({ release: 8 }),
    [placed({ instance: 0, release: 7, state: "draining" }),
     placed({ instance: 1, release: 8, state: "ready", node: "n2" })], alive, NOW, true);
  assert.deepEqual(kinds(gone), ["remove"]);
});

// A new instance that has not come up yet must not cause the old one to drain —
// that would be stop-then-start with extra steps.
test("a new release that is still starting does not drain the old one", () => {
  const steps = planPlacements(desired({ release: 8 }),
    [placed({ instance: 0, release: 7, state: "ready" }),
     placed({ instance: 1, release: 8, state: "starting", node: "n2" })], alive, NOW, true);
  assert.deepEqual(steps, []);
});

// The lease. Expiry gives the control plane the RIGHT to re-place; it is not an
// instruction to the node, which keeps serving. See the architecture spec §10.
test("an expired lease on a silent node is evicted when the fleet can be seen", () => {
  const steps = planPlacements(desired(),
    [placed({ leaseUntil: NOW - 1 })],
    [{ name: "n1", healthy: false, load: 0 }, { name: "n2", healthy: true, load: 0 }, { name: "n3", healthy: true, load: 0 }],
    NOW, true);
  assert.deepEqual(kinds(steps), ["evict"]);
  assert.equal(steps[0].instance, 0);
});

// The half that stops a partition becoming two copies of an app. If the control
// plane cannot see the fleet, the isolated party is probably the control plane,
// and the correct action is none.
test("an expired lease is HELD when the fleet cannot be seen", () => {
  const steps = planPlacements(desired(),
    [placed({ leaseUntil: NOW - 1 })],
    [{ name: "n1", healthy: false, load: 0 }, { name: "n2", healthy: false, load: 0 }, { name: "n3", healthy: false, load: 0 }],
    NOW, false);
  assert.deepEqual(steps, [], "no quorum means no eviction, however long the silence");
});

// A volume pins an app to its node (spec §8), and the reconciler must respect it.
// Evicting one would move it away from the only disk holding its data.
test("an app pinned by a volume is never moved, even with an expired lease", () => {
  const steps = planPlacements(desired({ pinnedTo: "n1" }),
    [placed({ leaseUntil: NOW - 1 })],
    [{ name: "n1", healthy: false, load: 0 }, { name: "n2", healthy: true, load: 0 }, { name: "n3", healthy: true, load: 0 }],
    NOW, true);
  assert.deepEqual(steps, [], "moving it would separate the app from its data");
});

test("an app that should not run anywhere has its placements removed", () => {
  const steps = planPlacements(desired({ release: null }), [placed()], alive, NOW, true);
  assert.deepEqual(kinds(steps), ["remove"]);
});

// Nowhere to put it is a fact to report, not a placement on a node named null.
test("no live node means no step, rather than a placement nowhere", () => {
  const steps = planPlacements(desired(), [], [{ name: "n1", healthy: false, load: 0 }], NOW, true);
  assert.deepEqual(steps, []);
});

// Spreading, not packing: the same reason chooseNode refuses to bin-pack. Two
// instances of one app on one machine is one machine away from zero instances.
test("a second instance goes to a different node from the first", () => {
  const steps = planPlacements(desired({ replicas: 2 }), [placed({ node: "n1" })], alive, NOW, true);
  assert.equal(steps.length, 1);
  assert.notEqual(place(steps).node, "n1", "two instances on one node is not two instances");
});

// The case production had and the planner did not: an app with MORE instances
// than it is asked for. placeApp upserts on (slug, node), so a deploy that
// chose a different node from the last one wrote a second row rather than
// moving the first — and placementFor reads with LIMIT 1, so nothing in the
// code ever saw the second. fleet-place.ts warned about exactly this shape:
// "two copies of the app running at once, which is exactly what this sequence
// exists to prevent."
test("an app with more instances than it asked for loses the extra ones", () => {
  const steps = planPlacements(desired({ replicas: 1 }),
    [placed({ instance: 0, node: "n1" }), placed({ instance: 1, node: "n2" })], alive, NOW, true);
  assert.deepEqual(kinds(steps), ["remove"]);
  assert.equal(steps[0].instance, 1, "the lowest-numbered instances are the ones kept");
});

// Draining first, because an instance that is already going does not need a
// second decision — and counting it as surplus would remove it before it had
// finished the requests it is holding.
test("surplus is counted among what is running, not among what is already leaving", () => {
  const steps = planPlacements(desired({ replicas: 1 }),
    [placed({ instance: 0 }), placed({ instance: 1, node: "n2", state: "draining" })], alive, NOW, true);
  assert.deepEqual(kinds(steps), ["remove"], "the draining one is removed because it is draining, not because it is surplus");
  assert.equal(steps[0].instance, 1);
});

test("asking for no instances at all removes them without asking for a release change", () => {
  const steps = planPlacements(desired({ replicas: 0 }), [placed()], alive, NOW, true);
  assert.deepEqual(kinds(steps), ["remove"]);
});

/* -------------------------------------------------------------------------- */
/* Rebalancing                                                                 */
/* -------------------------------------------------------------------------- */

test("a lopsided fleet moves one app towards the emptier node", () => {
  // The fleet only levelled out as new apps arrived. After a node failure and
  // its recovery, fleet-lab-1 sat empty while fleet-lab-3 carried nineteen —
  // and nothing would ever have moved one back.
  //
  // BESIDE FIRST, never instead: this emits a place on the emptier node while
  // the app keeps serving from where it is. The trim on the next pass is what
  // removes the old one, and only once this one exists.
  const steps = planPlacements(
    desired(),
    [placed({ node: "n3" })],
    // n3 is carrying nine more than n1.
    [{ name: "n1", healthy: true, load: 1 }, { name: "n2", healthy: true, load: 5 }, { name: "n3", healthy: true, load: 10 }],
    NOW,
    true,
  );
  const p = place(steps);
  assert.equal(p.node, "n1", "the emptiest healthy node");
  assert.equal(p.instance, 1, "beside the one already there, not over it");
});

test("a fleet that is close enough is left alone", () => {
  // The threshold is what stops this thrashing. One placement of difference is
  // not an imbalance worth moving an app for — and moving one would create the
  // mirror image of the same difference, which is how a rebalancer oscillates
  // forever.
  const steps = planPlacements(desired(), [placed({ node: "n2" })], loaded(2, 3, 2), NOW, true);
  assert.deepEqual(steps, []);
});

test("an app pinned to its data is never rebalanced", () => {
  // The pin exists because /srv/apps/<slug>/data is on one machine and nothing
  // replicates it. Rebalancing is the one caller that would move an app for no
  // reason other than tidiness, which makes it the worst possible reason to
  // leave data behind.
  const steps = planPlacements(
    desired({ pinnedTo: "n3" }),
    [placed({ node: "n3" })],
    loaded(0, 5, 10),
    NOW,
    true,
  );
  assert.deepEqual(steps, []);
});

test("nothing is rebalanced without quorum", () => {
  // Same rule as eviction, and for a stronger reason: a control plane that
  // cannot see the fleet cannot know what the loads ARE, so every number it
  // would be balancing against is stale.
  const steps = planPlacements(desired(), [placed({ node: "n3" })], loaded(0, 5, 10), NOW, false);
  assert.deepEqual(steps, []);
});

test("a placement that is not ready yet is not rebalanced", () => {
  // Mid-deploy or mid-recovery, the loads are still moving. Moving an app that
  // has not finished arriving would abandon a pull that is already half done.
  const steps = planPlacements(
    desired(),
    [placed({ node: "n3", state: "starting" })],
    loaded(0, 5, 10),
    NOW,
    true,
  );
  assert.deepEqual(steps, []);
});

test("the extra instance is trimmed from the fuller node, which completes the move", () => {
  // The other half. Without this the trim keeps the lowest instance number —
  // the ORIGINAL — and the rebalance undoes itself every pass, moving an app
  // back and forth forever.
  const steps = planPlacements(
    desired(),
    [placed({ instance: 0, node: "n3" }), placed({ instance: 1, node: "n1" })],
    loaded(1, 5, 10),
    NOW,
    true,
  );
  assert.deepEqual(steps, [{ kind: "remove", slug: "lilna", instance: 0 }]);
});
