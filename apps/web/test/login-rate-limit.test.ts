import { test, mock } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

/**
 * That the password path is no longer the one door with no lock on it.
 *
 * Tested against lib/credentials-login rather than auth.ts, because auth.ts
 * exports only what NextAuth hands back — the provider array is local and the
 * authorize closure inside it is unreachable. A brute-force gate nobody can
 * write a test against is a gate nobody can prove still works after the next
 * edit, which is why the function was moved out before it was guarded.
 */

const takes: { scope: string; key: string }[] = [];
let verdict: { ok: boolean; retryAfterSec?: number } = { ok: true };
let lookups = 0;

/**
 * bcrypt is REAL here, not mocked.
 *
 * `mock.module("bcryptjs", { defaultExport: ... })` does not take — it is a CJS
 * module reached through a default import, and the mock silently fails to
 * apply. Measured rather than assumed: a probe asserting the mocked `compare`
 * returned true failed against the real one. A test built on that mock would
 * have passed for the wrong reason, since every assertion about bcrypt NOT
 * being called is trivially true when the mock is inert.
 *
 * So the password below is hashed for real, at cost 4 to keep the suite quick,
 * and the ordering assertions ride on the database lookup instead: the lookup
 * happens before the hash comparison, so a gate that ran before the lookup ran
 * before both.
 */
const PASSWORD = "hunter2";
const HASH = bcrypt.hashSync(PASSWORD, 4);

mock.module("@/lib/rate-limit", {
  namedExports: {
    takeToken: async (scope: string, key: string) => {
      takes.push({ scope, key });
      return verdict;
    },
  },
});

mock.module("@/lib/client-ip", {
  namedExports: { clientIp: () => "203.0.113.7" },
});

mock.module("@/lib/users", {
  namedExports: {
    findUserByEmailAndProvider: async () => {
      lookups++;
      return {
        id: "u1",
        email: "a@example.com",
        name: "A",
        password_hash: HASH,
      };
    },
    createUser: async () => ({ id: "u1" }),
    markEmailVerified: async () => undefined,
  },
});

const login$ = import("@/lib/credentials-login");

function creds() {
  return { email: "a@example.com", password: PASSWORD };
}
function request(): Request {
  return new Request("https://app.thebay.cloud/api/auth/callback/credentials");
}

async function authorize(): Promise<unknown> {
  const { authorizeCredentials } = await login$;
  return authorizeCredentials(creds(), request());
}

test("a refused attempt never reaches the database or the hash", async () => {
  takes.length = 0;
  lookups = 0;
  verdict = { ok: false, retryAfterSec: 300 };
  assert.equal(await authorize(), null);
  // The lookup is the assertion, and it covers the hash too: the comparison
  // happens after the row is fetched, so a gate that ran before the lookup ran
  // before both. A throttled attempt that still queried could also be timed
  // against a known-good address, which is a slower way of asking the very
  // question the gate exists to refuse.
  assert.equal(lookups, 0);
});

test("the key is the email and the address together, not either alone", async () => {
  takes.length = 0;
  verdict = { ok: true };
  await authorize();
  // Email alone would let anybody lock a victim out of their own account by
  // guessing at it from anywhere -- the protection becomes the attack. Address
  // alone would let one office behind a NAT exhaust the ceiling for everybody
  // sharing it. The pair is the smallest key that is neither.
  assert.deepEqual(takes, [
    { scope: "login:email-ip", key: "a@example.com|203.0.113.7" },
  ]);
});

test("a refusal is indistinguishable from a wrong password", async () => {
  takes.length = 0;
  verdict = { ok: false, retryAfterSec: 300 };
  // Null, exactly as a bad password returns null. Telling an attacker the
  // difference between "wrong" and "throttled" tells them the address exists,
  // which is the one fact the guessing was for.
  assert.equal(await authorize(), null);
});

test("a normal sign-in still succeeds", async () => {
  verdict = { ok: true };
  const user = await authorize();
  assert.deepEqual(user, { id: "u1", email: "a@example.com", name: "A" });
});

test("a missing password is refused before any token is spent", async () => {
  const { authorizeCredentials } = await login$;
  takes.length = 0;
  verdict = { ok: true };
  assert.equal(await authorizeCredentials({ email: "a@example.com" }, request()), null);
  // An empty submit is a slip, not an attempt. Counting it would let a stuck
  // form burn somebody's own ceiling and lock them out of their account.
  assert.equal(takes.length, 0);
});

test("the email is folded before it becomes part of the key", async () => {
  const { authorizeCredentials } = await login$;
  takes.length = 0;
  verdict = { ok: true };
  await authorizeCredentials({ email: "A@Example.COM", password: PASSWORD }, request());
  // Otherwise a guesser gets a fresh ceiling per capitalisation of the same
  // address, which is an unbounded number of them.
  assert.equal(takes[0].key, "a@example.com|203.0.113.7");
});
