import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyApp, type VerifyOptions } from "../lib/verify-app";

/**
 * What this suite is really pinning: a deploy that never answered used to be
 * published as a success, because the probe returned `{ok: true}` on any
 * exception including its own 20-second abort. Only 403, 5xx and one body regex
 * could fail it — a framework 404 page passed, a blank 200 passed.
 */

/** A fetch that replays a scripted sequence, so a cold start can be simulated. */
function scripted(responses: Array<{ status?: number; body?: string; throws?: string }>) {
  const seen: string[] = [];
  const impl = (async (url: string | URL) => {
    seen.push(String(url));
    const r = responses[Math.min(seen.length - 1, responses.length - 1)];
    if (r.throws) throw new Error(r.throws);
    return { status: r.status ?? 200, text: async () => r.body ?? "<html>ok</html>" } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, seen };
}

function opts(over: Partial<VerifyOptions> & { fetchImpl: typeof fetch }): VerifyOptions {
  return {
    url: "https://demo.example",
    health: { path: "/", expect: 200 },
    strict: false,
    // No real waiting: the retry schedule is behaviour, the sleeping is not.
    sleep: async () => {},
    ...over,
  };
}

test("an app that never answers is a failure, not a pass", async () => {
  const { impl, seen } = scripted([{ throws: "The operation was aborted" }]);
  const r = await verifyApp(opts({ fetchImpl: impl }));
  assert.equal(r.ok, false);
  assert.match(r.reason!, /never answered/);
  // It asked more than once before concluding that.
  assert.equal(seen.length, 4);
});

test("a cold start that answers on a later attempt passes", async () => {
  // The instinct behind the old catch-all was right — this case is real. What
  // was wrong was paying for it by never failing.
  const { impl, seen } = scripted([
    { throws: "connect ECONNREFUSED" },
    { throws: "connect ECONNREFUSED" },
    { status: 200 },
  ]);
  const r = await verifyApp(opts({ fetchImpl: impl }));
  assert.equal(r.ok, true);
  assert.equal(seen.length, 3);
});

test("a framework 404 page no longer publishes clean", async () => {
  const { impl } = scripted([{ status: 404, body: "<h1>Not Found</h1>" }]);
  const r = await verifyApp(opts({ fetchImpl: impl }));
  assert.equal(r.ok, false);
  assert.match(r.reason!, /HTTP 404/);
});

test("a persistent 500 fails, after being asked again", async () => {
  const { impl, seen } = scripted([{ status: 500, body: "boom" }]);
  const r = await verifyApp(opts({ fetchImpl: impl }));
  assert.equal(r.ok, false);
  assert.equal(seen.length, 4);
});

test("a 500 that clears on retry passes", async () => {
  const { impl } = scripted([{ status: 503 }, { status: 200 }]);
  assert.equal((await verifyApp(opts({ fetchImpl: impl }))).ok, true);
});

test("a redirect passes when nobody declared otherwise", async () => {
  // Plenty of correct apps send / to /login. Failing them would be the old bug
  // pointed the other way.
  const { impl } = scripted([{ status: 302 }]);
  assert.equal((await verifyApp(opts({ fetchImpl: impl }))).ok, true);
});

test("a declared expectation is enforced exactly", async () => {
  const { impl } = scripted([{ status: 302 }]);
  const r = await verifyApp(opts({
    fetchImpl: impl, strict: true, health: { path: "/api/health", expect: 200 },
  }));
  assert.equal(r.ok, false);
  assert.match(r.reason!, /the app declares it should return 200/);
});

test("the health path is what gets requested, not the root", async () => {
  const { impl, seen } = scripted([{ status: 200 }]);
  await verifyApp(opts({ fetchImpl: impl, strict: true, health: { path: "/api/health", expect: 200 } }));
  assert.equal(seen[0], "https://demo.example/api/health");
});

test("a sealed app the deployer cannot invoke is named as an IAM problem", async () => {
  const { impl } = scripted([{ status: 403 }]);
  const r = await verifyApp(opts({ fetchImpl: impl }));
  assert.equal(r.ok, false);
  assert.match(r.reason!, /run\.invoker/);
});

test("a server that is up and refusing the request is still a failure", async () => {
  const { impl } = scripted([{ status: 200, body: "Blocked request. This host is not allowed." }]);
  const r = await verifyApp(opts({ fetchImpl: impl }));
  assert.equal(r.ok, false);
  assert.match(r.reason!, /rejected the request/);
});

test("an SPA whose unknown paths 404 is caught before it goes live", async () => {
  // React Router 404ing on a refresh at /about is invisible from the root, and
  // is the most common way a "successful" static deploy is broken for its users.
  const impl = (async (url: string | URL) => {
    const is404 = String(url).includes("__supersonic_spa_check");
    return { status: is404 ? 404 : 200, text: async () => "" } as unknown as Response;
  }) as unknown as typeof fetch;
  const r = await verifyApp(opts({ fetchImpl: impl, spaFallback: true }));
  assert.equal(r.ok, false);
  assert.match(r.reason!, /declares spaFallback/);
});

test("an SPA that serves its shell for unknown paths passes", async () => {
  const { impl } = scripted([{ status: 200, body: "<div id=root>" }]);
  assert.equal((await verifyApp(opts({ fetchImpl: impl, spaFallback: true }))).ok, true);
});

test("an app that did not declare spaFallback is not asked the question", async () => {
  const { impl, seen } = scripted([{ status: 200 }]);
  await verifyApp(opts({ fetchImpl: impl }));
  assert.equal(seen.length, 1);
  assert.ok(!seen.some((u) => u.includes("__supersonic_spa_check")));
});
