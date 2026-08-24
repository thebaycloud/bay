import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

/**
 * THE LOGIN IS NOT ON THE REQUEST PATH ANY MORE.
 *
 * Umami is a Next.js app on Cloud Run with no minimum instance, and a cold login
 * is one container start plus one bcrypt: 13–26 seconds, measured against the
 * running instance on 24 Aug. This module used to await that inside `/_xray`,
 * behind a ten-second deadline, so every cold read aborted and the owner was
 * told the count could not be read — while the service they were waiting on sat
 * there hashing a password.
 *
 * The polled read now refuses immediately and lets the NEXT poll, three seconds
 * later, find a warm token. These tests hold the login open forever to prove it:
 * if `audienceFor` waited, this file would time out rather than fail.
 */
process.env.UMAMI_URL = "http://umami.test";
process.env.UMAMI_PASSWORD = "hunter2";

const { audienceFor, resetAudience } = await import("./analytics");

let release: (() => void) | null = null;
let logins = 0;

/** A login that hangs until the test lets it finish; everything else is instant. */
function stub() {
  logins = 0;
  release = null;
  (globalThis as { fetch: unknown }).fetch = async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/auth/login")) {
      logins++;
      await new Promise<void>((res) => (release = res));
      return new Response(JSON.stringify({ token: "jwt" }), { status: 200 });
    }
    if (u.includes("/stats")) {
      return new Response(JSON.stringify({ pageviews: 179, visitors: 10, visits: 35, bounces: 16, totaltime: 19970 }), { status: 200 });
    }
    return new Response(JSON.stringify([{ x: "/", y: 10 }]), { status: 200 });
  };
}

beforeEach(() => {
  resetAudience();
  stub();
});

test("a cold read gives up at once instead of waiting for the login", async () => {
  // No timing assertion and none needed: the stubbed login never resolves, so a
  // version that awaited it could not reach the next line at all.
  const a = await audienceFor("w1", 1_000_000);
  assert.equal(a, null);
  assert.equal(logins, 1, "and it started the login it declined to wait for");
});

test("the next poll finds the token and answers", async () => {
  assert.equal(await audienceFor("w1", 1_000_000), null);
  release?.();
  await new Promise((r) => setTimeout(r, 10));

  // A minute later by the clock this function is given — the cache holds the
  // null for exactly as long as it holds a real reading.
  const a = await audienceFor("w1", 1_000_000 + 61_000);
  assert.ok(a, "the second read has a token and answers");
  assert.equal(a.visitors, 10);
  assert.equal(a.views, 179);
  assert.equal(a.bounce, 46);
  assert.equal(logins, 1, "one login, not one per read");
});

test("a hundred polls during a cold start cause one login between them", async () => {
  const all = await Promise.all(Array.from({ length: 100 }, () => audienceFor("w1", 1_000_000)));
  assert.ok(all.every((a) => a === null));
  // Twenty simultaneous bcrypts on an instance sized for a 2 KB tracker is how
  // the analytics falls over because somebody looked at the analytics.
  assert.equal(logins, 1);
});
