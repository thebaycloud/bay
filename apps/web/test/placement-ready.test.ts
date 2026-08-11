import { test } from "node:test";
import assert from "node:assert/strict";
import { readyInstances, type Confirmed, type Starting } from "@/lib/reconcile";

const starting = (o: Partial<Starting> = {}): Starting =>
  ({ slug: "lilna", instance: 1, image: "reg/lilna@sha256:new", ...o });
const confirmed = (o: Partial<Confirmed> = {}): Confirmed =>
  ({ slug: "lilna", image: "reg/lilna@sha256:new", healthy: true, ...o });

// The placement's state is what the rollout turns on: the planner will not drain
// the old instance until the new one is `ready`. Nothing wrote that field, so a
// rollout placed its new instance and stopped there — forever. Caught on q6doa,
// which sat at instance 0 ready on release 25 and instance 1 starting on 29.
test("a node confirming the release it was given promotes that instance", () => {
  assert.deepEqual(readyInstances([starting()], [confirmed()]), [{ slug: "lilna", instance: 1 }]);
});

// The IMAGE is the predicate, not the slug. A node that is still running the
// version being replaced reports the same slug, and promoting on the slug alone
// would mark the new instance ready on the strength of the old one answering —
// the same false positive placeOnFleet already guards its probe against.
test("a node still running the old release does not promote the new instance", () => {
  assert.deepEqual(readyInstances([starting()], [confirmed({ image: "reg/lilna@sha256:old" })]), []);
});

// Running is not serving. A web process that started and has not answered is
// exactly the thing that must not be treated as cover for draining another.
test("a process that is running but not healthy does not promote", () => {
  assert.deepEqual(readyInstances([starting()], [confirmed({ healthy: false })]), []);
});

// A worker has no port to probe, so the node reports no health for it at all —
// absent, not false. Absent must mean "not applicable" and promote, or a
// worker-only app could never finish a rollout.
test("a process with no health to report promotes on being run at all", () => {
  assert.deepEqual(readyInstances([starting()], [confirmed({ healthy: undefined })]),
    [{ slug: "lilna", instance: 1 }]);
});

test("nothing is promoted for an app the node says nothing about", () => {
  assert.deepEqual(readyInstances([starting()], [confirmed({ slug: "izuvx" })]), []);
});

test("several starting instances are each judged on their own release", () => {
  const out = readyInstances(
    [starting({ instance: 1 }), starting({ instance: 2, image: "reg/lilna@sha256:other" })],
    [confirmed()]);
  assert.deepEqual(out, [{ slug: "lilna", instance: 1 }]);
});
