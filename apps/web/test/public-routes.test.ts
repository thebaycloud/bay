import { test } from "node:test";
import assert from "node:assert/strict";
import { authConfig } from "../auth.config";

/**
 * What must work WITHOUT a session.
 *
 * `middleware-matcher.test.ts` covers the other half of this gate — the assets
 * the matcher must not catch at all. This covers the pages and routes that the
 * matcher DOES catch and that the `authorized` callback has to wave through,
 * where the failure mode is the same one that file describes: a 307 to /login
 * that nothing reports as an error.
 *
 * The three cases below are each a different flavour of "no cookie exists and
 * none can":
 *
 *   /forgot, /reset   the person is locked out — that is why they are here. Sent
 *                     to /login they land on the page they just failed at, and
 *                     the only route back into an account is a loop. This shipped
 *                     that way for one deploy and was caught by curl.
 *   /verify           clicked from a mail client. The TOKEN is the credential.
 *   /api/internal/*   called by a scheduler; authenticates with a shared secret
 *                     and 404s without one. Gated, it would never run, and a
 *                     sweep that never runs looks exactly like a quiet week.
 */

type Authorized = NonNullable<NonNullable<typeof authConfig.callbacks>["authorized"]>;
const authorized = authConfig.callbacks!.authorized! as Authorized;

/** The callback only reads pathname, method and one header. */
function answer(pathname: string, signedIn = false) {
  const request = {
    nextUrl: { pathname },
    method: "GET",
    headers: new Headers(),
  } as unknown as Parameters<Authorized>[0]["request"];
  const auth = (signedIn ? { user: { id: "u1" } } : null) as Parameters<Authorized>[0]["auth"];
  return authorized({ auth, request });
}

/**
 * Whether the gate lets the request through.
 *
 * NOT `Boolean(...)`. The callback has three answers now, not two: `true` waves
 * the request on, `false` sends a person to /login, and a Response is the gate
 * answering for itself — which is what a refused API call gets, so that a
 * program receives a 401 in JSON instead of a sign-in page. A Response is
 * truthy, so coercing it would read a refusal as permission, which is the one
 * mistake this file exists to catch.
 */
function allows(pathname: string, signedIn = false): boolean {
  return answer(pathname, signedIn) === true;
}

const MUST_BE_PUBLIC = [
  "/login",
  "/signup",
  "/forgot",
  "/reset",
  "/verify",
  "/api/auth/forgot",
  "/api/auth/reset",
  "/api/internal/error-sweep",
  "/api/billing/webhook",
  "/api/github/webhook",
];

const MUST_BE_GATED = [
  "/",
  "/settings",
  "/apps/abc12",
  "/api/apps",
  "/api/billing/checkout",
  "/api/billing/portal",
  // Adjacent to a public one on purpose: /api/auth is public, but the rest of
  // /api/billing is not, and a prefix written one character too short is how a
  // gate opens by accident.
  "/api/deploy",
];

test("account recovery works with no session", () => {
  // Named separately from the bulk case because this is the one where being
  // wrong locks somebody out of their account permanently.
  for (const p of ["/forgot", "/reset", "/api/auth/forgot", "/api/auth/reset"]) {
    assert.equal(allows(p), true, `${p} is behind the login gate — the locked-out user cannot reach it`);
  }
});

test("every route that cannot carry a cookie is reachable without one", () => {
  for (const p of MUST_BE_PUBLIC) {
    assert.equal(allows(p), true, `${p} is gated and cannot ever satisfy the gate`);
  }
});

test("everything else still needs a session", () => {
  for (const p of MUST_BE_GATED) {
    assert.equal(allows(p), false, `${p} is reachable signed out`);
    assert.equal(allows(p, true), true, `${p} refuses a signed-in user`);
  }
});

test("a gated page is refused with a redirect and a gated API with a 401", async () => {
  // The two halves of "refused" and why they differ: a person can read a
  // sign-in page, and a program cannot. `false` here means next-auth 307s to
  // /login; a Response means the gate answered in JSON. See lib/api-error.ts.
  for (const p of MUST_BE_GATED) {
    const refusal = await answer(p);
    if (p.startsWith("/api/")) {
      assert.ok(refusal instanceof Response, `${p} refuses a program with a sign-in page`);
      assert.equal(refusal.status, 401);
      assert.equal((await refusal.json()).code, "not_authenticated");
    } else {
      assert.equal(refusal, false, `${p} no longer redirects a signed-out person to /login`);
    }
  }
});
