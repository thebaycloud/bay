import { test } from "node:test";
import assert from "node:assert/strict";
import { isAdmin, envAdminEntries } from "../lib/admin";

test("nobody is an admin by default", () => {
  assert.equal(isAdmin("someone@example.com", []), false);
});

test("an exact email entry grants access, case- and space-insensitively", () => {
  const entries = [{ email: "ops@acme.com", domain: null }];
  assert.equal(isAdmin("ops@acme.com", entries), true);
  assert.equal(isAdmin("  OPS@Acme.COM  ", entries), true);
  assert.equal(isAdmin("other@acme.com", entries), false);
});

test("a domain entry grants access to that whole domain and no other", () => {
  const entries = [{ email: null, domain: "supersonic.cv" }];
  assert.equal(isAdmin("anyone@supersonic.cv", entries), true);
  assert.equal(isAdmin("anyone@acme.com", entries), false);
});

// The bug this guards is the reason admins do not share the sign-in table: a
// domain suffix match would hand production analytics to anyone who can register
// a domain ending in ours.
test("a lookalike domain is not the domain", () => {
  const entries = [{ email: null, domain: "supersonic.cv" }];
  assert.equal(isAdmin("attacker@evil-supersonic.cv", entries), false);
  assert.equal(isAdmin("attacker@supersonic.cv.evil.com", entries), false);
});

// `allowed_signins` uses a '*' domain to mean "signups are open to everyone".
// If that row ever appeared here — or if the two tables were ever merged — it
// would make every user of the product an operator.
test("a wildcard entry is not an admin grant", () => {
  assert.equal(isAdmin("anyone@anywhere.com", [{ email: null, domain: "*" }]), false);
  assert.equal(isAdmin("anyone@anywhere.com", [{ email: null, domain: " * " }]), false);
});

test("a wildcard alongside a real entry leaves the real entry working", () => {
  const entries = [
    { email: null, domain: "*" },
    { email: "ops@acme.com", domain: null },
  ];
  assert.equal(isAdmin("ops@acme.com", entries), true);
  assert.equal(isAdmin("anyone@anywhere.com", entries), false);
});

test("malformed addresses are refused rather than matched loosely", () => {
  const entries = [{ email: null, domain: "acme.com" }];
  assert.equal(isAdmin("", entries), false);
  assert.equal(isAdmin("acme.com", entries), false);
  assert.equal(isAdmin("@acme.com", entries), false);
});

test("ADMIN_EMAILS parses a comma list and ignores the junk in it", () => {
  assert.deepEqual(envAdminEntries("a@x.com, B@Y.com ,, not-an-email, "), [
    { email: "a@x.com", domain: null },
    { email: "b@y.com", domain: null },
  ]);
});

test("an unset or empty ADMIN_EMAILS grants nobody anything", () => {
  assert.deepEqual(envAdminEntries(undefined), []);
  assert.deepEqual(envAdminEntries(""), []);
  assert.deepEqual(envAdminEntries("   "), []);
  // The parsed result must also be inert as an entry list.
  assert.equal(isAdmin("a@x.com", envAdminEntries("")), false);
});
