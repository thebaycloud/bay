import { test } from "node:test";
import assert from "node:assert/strict";
import { shipPush, whoPushed, cloneUrlForPush, type ShipDeps } from "../lib/github-deploy";
import type { Push } from "../lib/github-webhook";
import type { PushTarget } from "../lib/app-repos";

/**
 * What a push means. Every branch here is a decision made with no session, no
 * caller to return an error to, and money on the other side of it — so each one
 * is asserted directly rather than inferred from a deploy that did or did not
 * happen.
 */

const SHA = "9f2c1a4b8e7d6c5b4a3928170615243342516170";

const PUSH: Push = {
  repoId: 42,
  repoFullName: "thebaycloud/bay",
  branch: "main",
  sha: SHA,
  message: "One clock is the clock",
  author: "Rakhat",
  senderLogin: "onlytenders",
};

const TARGET: PushTarget = {
  slug: "q13fh",
  installationId: 155650459,
  repoId: 42,
  repoFullName: "thebaycloud/bay",
  branch: "main",
  autoDeploy: true,
  connectedAt: null,
  ownerId: "owner-1",
  workspaceId: "ws-1",
  repoUrl: "https://github.com/thebaycloud/bay",
  connectedLogin: "onlytenders",
};

/** Deps that never touch a database, GitHub or Cloud Run. */
function deps(over: Partial<ShipDeps> = {}) {
  const calls: { dispatched: number; statuses: unknown[]; recorded: unknown[]; charged: number } =
    { dispatched: 0, statuses: [], recorded: [], charged: 0 };
  const d: Partial<ShipDeps> = {
    target: async () => TARGET,
    refreshName: async () => {},
    plan: async () => ({ locked: false, monthlyBuilds: 100 }),
    charge: async () => { calls.charged++; return true; },
    record: async (runId, slug, who, commit) => { calls.recorded.push({ runId, slug, who, commit }); },
    dispatch: async () => { calls.dispatched++; },
    status: async (o) => { calls.statuses.push(o); return true; },
    jobEnabled: true,
    ...over,
  };
  return { d, calls };
}

test("a push to a connected branch becomes a build", async () => {
  const { d, calls } = deps();
  const r = await shipPush(PUSH, d);
  assert.equal(r.shipped, true);
  assert.equal(r.shipped && r.slug, "q13fh");
  assert.equal(calls.dispatched, 1);
  assert.equal(calls.charged, 1);
});

test("the build records the commit that caused it", async () => {
  const { d, calls } = deps();
  await shipPush(PUSH, d);
  assert.deepEqual((calls.recorded[0] as { commit: unknown }).commit, {
    sha: SHA, branch: "main", message: "One clock is the clock", author: "Rakhat",
  });
});

/**
 * The pending status is what makes the commit say something while the build
 * runs, and it must arrive AFTER the dispatch — a tick on a build that was
 * refused is a lie nothing later comes back to correct.
 */
test("a pending status is posted, pointing at the app's own address", async () => {
  const { d, calls } = deps();
  await shipPush(PUSH, d);
  assert.equal(calls.statuses.length, 1);
  assert.partialDeepStrictEqual(calls.statuses[0], {
    state: "pending",
    sha: SHA,
    fullName: "thebaycloud/bay",
    slug: "q13fh",
    targetUrl: "https://q13fh.supersonic.cv",
  });
});

test("a push nobody connected costs one query and nothing else", async () => {
  const { d, calls } = deps({ target: async () => null });
  const r = await shipPush(PUSH, d);
  assert.deepEqual(r, { shipped: false, reason: "no-app-follows-this-branch" });
  assert.equal(calls.dispatched, 0);
  assert.equal(calls.charged, 0);
  assert.equal(calls.statuses.length, 0);
});

test("auto-deploy off is a different answer from nobody connected", async () => {
  const { d, calls } = deps({ target: async () => ({ ...TARGET, autoDeploy: false }) });
  const r = await shipPush(PUSH, d);
  assert.deepEqual(r, { shipped: false, reason: "auto-deploy-off", slug: "q13fh" });
  assert.equal(calls.dispatched, 0);
  // Not charged: a build that never happened must not be paid for.
  assert.equal(calls.charged, 0);
});

test("a reached build limit refuses before anything is dispatched", async () => {
  const { d, calls } = deps({ charge: async () => false });
  const r = await shipPush(PUSH, d);
  assert.deepEqual(r, { shipped: false, reason: "build-limit-reached", slug: "q13fh" });
  assert.equal(calls.dispatched, 0);
  assert.equal(calls.statuses.length, 0);
});

test("a locked account refuses before the meter is touched", async () => {
  const { d, calls } = deps({ plan: async () => ({ locked: true, monthlyBuilds: 0 }) });
  const r = await shipPush(PUSH, d);
  assert.deepEqual(r, { shipped: false, reason: "no-account", slug: "q13fh" });
  assert.equal(calls.charged, 0);
});

/**
 * Without a job to execute in, there is nowhere for the build to run. Refusing
 * is the only honest answer: letting it through would leave a `pending` status
 * on a commit that nothing ever comes back to resolve.
 */
test("no deploy job means a named refusal, not a hang", async () => {
  const { d, calls } = deps({ jobEnabled: false });
  const r = await shipPush(PUSH, d);
  assert.deepEqual(r, { shipped: false, reason: "deploy-job-disabled", slug: "q13fh" });
  assert.equal(calls.statuses.length, 0);
});

test("a dispatch that throws reports `error` on the commit, not `failure`", async () => {
  const { d, calls } = deps({ dispatch: async () => { throw new Error("the job was not updated"); } });
  const r = await shipPush(PUSH, d);
  assert.deepEqual(r, { shipped: false, reason: "dispatch-failed", slug: "q13fh" });
  assert.partialDeepStrictEqual(calls.statuses[0], { state: "error" });
  assert.match(String((calls.statuses[0] as { description: string }).description), /the job was not updated/);
});

/**
 * CONTEXT.md: "When nobody said, the answer is `someone` — never a guess,
 * because a wrong name here is worse than no name."
 */
test("who pushed is a fact or it is `someone`", () => {
  assert.equal(whoPushed("onlytenders", "onlytenders"), "you");
  assert.equal(whoPushed("OnlyTenders", "onlytenders"), "you");
  assert.equal(whoPushed("ilmak1704", "onlytenders"), "someone");
  // An organisation installation names nobody, so every org push is `someone`.
  assert.equal(whoPushed("onlytenders", null), "someone");
  assert.equal(whoPushed("", "onlytenders"), "someone");
});

test("an org push is recorded as `someone` even when the pusher connected it", async () => {
  const { d, calls } = deps({ target: async () => ({ ...TARGET, connectedLogin: null }) });
  await shipPush(PUSH, d);
  assert.equal((calls.recorded[0] as { who: string }).who, "someone");
});

/**
 * Built from the name in THIS push, so a repository renamed in GitHub is cloned
 * under its new name on the very next push rather than one push later.
 */
test("the clone url comes from the push, not from the stored column", () => {
  assert.equal(cloneUrlForPush("thebaycloud/renamed"), "https://github.com/thebaycloud/renamed.git");
});
