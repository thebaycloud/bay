import { test } from "node:test";
import assert from "node:assert/strict";
import { startBridge, redeployScript } from "../lib/agents/bridge";

/**
 * The bridge is the only thing that decides whether a repair worked, so every
 * rule in it is here. All of them exist because of something that happened.
 */

const post = (url: string) =>
  fetch(`${url}/redeploy`, { method: "POST" }).then((r) => r.json() as Promise<{ ok: boolean; url?: string; error?: string }>);

const never = () => false;

test("a successful redeploy becomes the ground truth", async () => {
  const b = await startBridge({
    redeploy: async () => ({ ok: true, url: "https://x.supersonic.cv" }),
    log: () => {}, maxRedeploys: 3, sameFailure: never,
  });
  try {
    assert.equal(b.lastUrl(), undefined, "nothing claimed before anything ran");
    const r = await post(b.url);
    assert.equal(r.ok, true);
    assert.equal(b.lastUrl(), "https://x.supersonic.cv");
    assert.equal(b.redeploys(), 1);
  } finally { b.close(); }
});

test("concurrent calls attach to one build, they do not start two", async () => {
  // A real redeploy outlives the agent's bash-tool timeout, so the agent kills
  // redeploy.sh mid-build and retries. Two builds racing on one slug can leave
  // the release pointer on an incomplete one.
  let started = 0;
  const b = await startBridge({
    redeploy: async () => {
      started++;
      await new Promise((r) => setTimeout(r, 250));
      return { ok: true, url: "https://x" };
    },
    log: () => {}, maxRedeploys: 5, sameFailure: never,
  });
  try {
    const [a, c, d] = await Promise.all([post(b.url), post(b.url), post(b.url)]);
    assert.equal(started, 1, "one build for three calls");
    for (const r of [a, c, d]) assert.equal(r.url, "https://x", "all three get the real result");
    assert.equal(b.redeploys(), 1);
  } finally { b.close(); }
});

test("the build budget is enforced", async () => {
  const b = await startBridge({
    redeploy: async () => ({ ok: false, error: "nope" }),
    log: () => {}, maxRedeploys: 2, sameFailure: never,
  });
  try {
    await post(b.url);
    await post(b.url);
    const third = await post(b.url);
    assert.equal(third.ok, false);
    assert.match(third.error!, /limit reached/);
    assert.equal(b.redeploys(), 2, "the refused call did not count as a build");
  } finally { b.close(); }
});

test("two identical failures stop the agent editing", async () => {
  // The attempt counter could say it had run out of tries; it could never say it
  // had run out of ideas. Two deploys failing the same way are evidence the
  // edits in between are not touching the cause.
  const b = await startBridge({
    redeploy: async () => ({ ok: false, error: "container did not listen on $PORT" }),
    log: () => {}, maxRedeploys: 10,
    sameFailure: (a, c) => a === c,
  });
  try {
    await post(b.url);
    await post(b.url);
    const third = await post(b.url);
    assert.equal(third.ok, false);
    assert.match(third.error!, /same reason/);
    assert.ok(b.redeploys() < 3, "it stopped before spending a third build");
  } finally { b.close(); }
});

test("a different failure resets the patience", async () => {
  let n = 0;
  const b = await startBridge({
    redeploy: async () => ({ ok: false, error: `failure ${n++}` }),
    log: () => {}, maxRedeploys: 10,
    sameFailure: (a, c) => a === c,
  });
  try {
    await post(b.url);
    await post(b.url);
    const third = await post(b.url);
    assert.ok(!/same reason/.test(third.error ?? ""), "progress is not punished");
  } finally { b.close(); }
});

test("a throwing pipeline is an answer, not a hang", async () => {
  const b = await startBridge({
    redeploy: async () => { throw new Error("cloud build exploded"); },
    log: () => {}, maxRedeploys: 3, sameFailure: never,
  });
  try {
    const r = await post(b.url);
    assert.equal(r.ok, false);
    assert.match(r.error!, /exploded/);
    // And the next call must still work — a thrown build must not wedge inFlight.
    const again = await post(b.url);
    assert.equal(again.ok, false);
  } finally { b.close(); }
});

test("only POST /redeploy is served", async () => {
  const b = await startBridge({
    redeploy: async () => ({ ok: true }), log: () => {}, maxRedeploys: 1, sameFailure: never,
  });
  try {
    assert.equal((await fetch(`${b.url}/redeploy`)).status, 404, "GET is not a deploy");
    assert.equal((await fetch(`${b.url}/other`, { method: "POST" })).status, 404);
    assert.equal(b.redeploys(), 0);
  } finally { b.close(); }
});

test("the script targets the bridge's URL, not a hardcoded loopback", async () => {
  // This is what makes moving the agent into a sandbox on a fleet node a
  // configuration change: there, 127.0.0.1 is the sandbox's own loopback.
  const s = redeployScript("http://10.200.0.1:41234");
  assert.match(s, /http:\/\/10\.200\.0\.1:41234\/redeploy/);
  assert.ok(!s.includes("127.0.0.1"), "no loopback is baked in");
  assert.match(s, /DEPLOY_OK/);
  assert.match(s, /DEPLOY_FAIL/);
});
