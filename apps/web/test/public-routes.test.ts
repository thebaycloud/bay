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
function allows(pathname: string, signedIn = false): boolean {
  const request = {
    nextUrl: { pathname },
    method: "GET",
    headers: new Headers(),
  } as unknown as Parameters<Authorized>[0]["request"];
  const auth = (signedIn ? { user: { id: "u1" } } : null) as Parameters<Authorized>[0]["auth"];
  return Boolean(authorized({ auth, request }));
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
