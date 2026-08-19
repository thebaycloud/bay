import { test } from "node:test";
import assert from "node:assert/strict";
import { advise, type RollbackSubject, type RollbackDeps } from "../lib/rollback-advice";
import type { AppSpec } from "../lib/fleet-spec";

const subject = (over: Partial<RollbackSubject> = {}): RollbackSubject => ({
  slug: "demo", staticServe: false, serviceless: false, canAutoRollback: false, ...over,
});

function deps(over: Partial<RollbackDeps> = {}) {
  const logs: string[] = [];
  const base: RollbackDeps = {
    log: (l) => logs.push(l),
    placementFor: async () => ({ node: "fleet-lab-2", spec: {} as AppSpec }),
    ...over,
  };
  return { deps: base, logs };
}

test("a database hiccup while checking never escapes", async () => {
  // The one that matters. This runs on the failure path of every deploy, and an
  // error thrown here reaches the outer catch INSTEAD of the deploy's real
  // error — taking the error event, the fix prompt, the upgrade path and the
  // failure record with it, because that catch cannot produce any of them for a
  // thrown, unclassified error. The user would be told about Postgres when
  // their build failed on a missing lockfile.
  const { deps: d, logs } = deps({
    placementFor: async () => { throw new Error("terminating connection due to administrator command"); },
  });

  const got = await advise(subject(), d);

  assert.equal(got, null, "an unreadable placement is not advice, and not an exception either");
  assert.ok(logs.some((l) => /could not check the fleet placement/.test(l)),
    "…but it is said out loud, or the check silently reads as 'no previous version'");
});

test("a placement that survived means the previous version is serving", async () => {
  const { deps: d } = deps();
  const got = await advise(subject(), d);
  assert.match(got!, /previous version is still \(or already back\) serving/);
});

test("no placement reads as a first deploy, not as a rollback that failed", async () => {
  // The two causes — never deployed, or a single failed attempt that correctly
  // unplaced itself — are one fact to the person reading it.
  const { deps: d } = deps({ placementFor: async () => null });
  const got = await advise(subject(), d);
  assert.match(got!, /no previous placement/);
});

test("nothing is claimed for an app whose address shows no version", async () => {
  // A static app's failed publish leaves the pointer untouched, and an app with
  // no web process has no address anybody could see a version at. Advice about
  // rolling back would be advice about nothing.
  for (const over of [{ staticServe: true }, { serviceless: true }]) {
    const { deps: d, logs } = deps();
    assert.equal(await advise(subject(over), d), null, JSON.stringify(over));
    assert.deepEqual(logs, [], "and nothing is said about it either");
  }
});

test("a target that rolls itself back is left to do it", async () => {
  const { deps: d } = deps();
  assert.equal(await advise(subject({ canAutoRollback: true }), d), null);
});

test("nothing here says 'we rolled back', because nothing here rolls back", async () => {
  // Claiming an action the platform did not take is how somebody comes to rely
  // on a mechanism that does not exist.
  const placed = await advise(subject(), deps().deps);
  const absent = await advise(subject(), deps({ placementFor: async () => null }).deps);
  for (const s of [placed, absent]) {
    assert.doesNotMatch(s!, /\bwe (rolled|have rolled)\b/i);
    assert.doesNotMatch(s!, /rolling back now/i);
  }
});
