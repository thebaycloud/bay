import { test, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * That signup stops being an unlimited way to mint free accounts.
 *
 * Two things are asserted that a reading of the route cannot promise: that the
 * gate runs BEFORE bcrypt, and that both keys are taken. The first is an
 * ordering, which is exactly the kind of property a later edit reorders without
 * noticing; the second is the difference between catching one machine in a loop
 * and catching a farm that rotates addresses.
 */

const takes: { scope: string; key: string }[] = [];
let verdict: { ok: boolean; retryAfterSec?: number } = { ok: true };
let bcryptCalls = 0;
let existing: unknown = null;

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

mock.module("bcryptjs", {
  defaultExport: {
    hash: async () => {
      bcryptCalls++;
      return "hashed";
    },
    compare: async () => true,
  },
});

mock.module("@/lib/users", {
  namedExports: {
    findUserByEmailAndProvider: async () => existing,
    createUser: async () => ({ id: "u1" }),
  },
});

const route$ = import("@/app/api/signup/route");

function post(email: string): Request {
  return new Request("https://app.thebay.cloud/api/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "hunter2", name: "A" }),
  });
}

test("a refused signup never reaches bcrypt", async () => {
  const { POST } = await route$;
  takes.length = 0;
  bcryptCalls = 0;
  existing = null;
  verdict = { ok: false, retryAfterSec: 42 };
  const res = await POST(post("a@example.com"));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "42");
  // bcrypt at cost 10 is deliberately slow, which makes an unlimited signup
  // route a CPU exhaustion surface on its own -- separately from how many
  // accounts it creates. The gate must run BEFORE it, and this is the assertion
  // that says so rather than hoping the lines stay in that order.
  assert.equal(bcryptCalls, 0);
});

test("signup is keyed on both the address and the email domain", async () => {
  const { POST } = await route$;
  takes.length = 0;
  existing = null;
  verdict = { ok: true };
  await POST(post("a@example.com"));
  assert.deepEqual(takes, [
    { scope: "signup:ip", key: "203.0.113.7" },
    { scope: "signup:email-domain", key: "example.com" },
  ]);
});

test("the domain key is case-folded, so one domain is one bucket", async () => {
  const { POST } = await route$;
  takes.length = 0;
  existing = null;
  verdict = { ok: true };
  await POST(post("a@EXAMPLE.com"));
  assert.equal(takes[1].key, "example.com");
});

test("an allowed signup still creates the account", async () => {
  const { POST } = await route$;
  existing = null;
  verdict = { ok: true };
  const res = await POST(post("b@example.com"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, id: "u1" });
});

test("the gate runs before the duplicate check, not after", async () => {
  const { POST } = await route$;
  takes.length = 0;
  existing = { id: "already" };
  verdict = { ok: false, retryAfterSec: 42 };
  const res = await POST(post("a@example.com"));
  // A throttled caller gets 429 and NOT "an account with that email already
  // exists". Answering the duplicate question first would turn the signup route
  // into an unlimited oracle for which addresses are registered -- a slower way
  // to leak the user list, but an unlimited one.
  assert.equal(res.status, 429);
});
