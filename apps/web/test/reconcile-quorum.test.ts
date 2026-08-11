import { test } from "node:test";
import assert from "node:assert/strict";
import { hasQuorum, nodeHealth, type NodeSeen } from "@/lib/reconcile";

const NOW = 1_000_000_000_000;
const LEASE = 120_000;
const seen = (name: string, agoMs: number, drain = false): NodeSeen =>
  ({ name, lastSeen: NOW - agoMs, drain });

// Quorum is what stops a partition becoming two copies of an app. The control
// plane may only take a placement back while it can see enough of the fleet to
// be sure it is not the isolated party.
test("a fleet that is all reporting has quorum", () => {
  assert.equal(hasQuorum([seen("n1", 1_000), seen("n2", 1_000), seen("n3", 1_000)], NOW, LEASE), true);
});

test("one silent node out of three still leaves quorum", () => {
  assert.equal(hasQuorum([seen("n1", 1_000), seen("n2", 1_000), seen("n3", 999_000)], NOW, LEASE), true);
});

test("two silent out of three loses quorum, and nothing may be evicted", () => {
  assert.equal(hasQuorum([seen("n1", 1_000), seen("n2", 999_000), seen("n3", 999_000)], NOW, LEASE), false);
});

// The finding that revised the spec on 11 Aug. A majority of two is two, so ONE
// silent node puts a two-node fleet below the threshold and eviction never fires
// — in either direction, at any silence. That is not a bug to work around by
// lowering the threshold: lowering it makes a two-node fleet evict on a
// partition in whichever direction the control plane happens to be reachable
// from, which is the two-copies hazard. The guarantee arrives at three.
test("a two-node fleet cannot evict, and that is the honest answer rather than a lowered bar", () => {
  assert.equal(hasQuorum([seen("n1", 1_000), seen("n2", 1_000)], NOW, LEASE), true, "both reporting is quorum");
  assert.equal(hasQuorum([seen("n1", 1_000), seen("n2", 999_000)], NOW, LEASE), false,
    "one silent of two is not a majority — the fleet cannot evict until there are three");
});

// With one node there is nowhere to move an app to, and `chooseNode` would
// return nothing anyway. Reporting quorum here would be a decision with no
// action behind it.
test("a single node is its own majority while it reports, and nothing when it does not", () => {
  assert.equal(hasQuorum([seen("n1", 1_000)], NOW, LEASE), true);
  assert.equal(hasQuorum([seen("n1", 999_000)], NOW, LEASE), false);
});

// An empty fleet is not a quorum of zero. Every predicate over an empty set is
// vacuously true, and "may I evict?" answering yes when there are no nodes is
// exactly the shape of bug that vacuous truth produces.
test("an empty fleet has no quorum", () => {
  assert.equal(hasQuorum([], NOW, LEASE), false);
});

// A draining node is deliberately leaving. Counting it in the denominator would
// let a drain push the fleet below quorum and freeze eviction for everyone else
// — the operation meant to move apps off a node would stop apps being moved.
test("a draining node counts in neither half", () => {
  assert.equal(hasQuorum([seen("n1", 1_000), seen("n2", 999_000), seen("n3", 1_000, true)], NOW, LEASE), false,
    "one of two live nodes silent is not a majority — the drained third does not rescue it");
  assert.equal(hasQuorum([seen("n1", 1_000), seen("n2", 1_000), seen("n3", 999_000, true)], NOW, LEASE), true);
});

test("health is measured against the lease window, not against a guess", () => {
  const nodes = [seen("n1", LEASE - 1), seen("n2", LEASE + 1)];
  assert.deepEqual(nodeHealth(nodes, NOW, LEASE), [
    { name: "n1", healthy: true },
    { name: "n2", healthy: false },
  ]);
});

// A draining node must not receive new placements. `chooseNode` already refuses
// one; the planner is handed nodes and cannot know, so it is told here.
test("a draining node is never healthy for placement, however recently it spoke", () => {
  assert.deepEqual(nodeHealth([seen("n1", 1, true)], NOW, LEASE), [{ name: "n1", healthy: false }]);
});
