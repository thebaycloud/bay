import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublicEmailProvider, domainOf, normalizeDomain } from "../lib/workspace";

test("domainOf lowercases and takes the part after @", () => {
  assert.equal(domainOf("Dana@Acme.COM"), "acme.com");
});

test("company domains are not public providers", () => {
  assert.equal(isPublicEmailProvider("acme.com"), false);
  assert.equal(isPublicEmailProvider("supersonic.cv"), false);
});

test("consumer providers are public", () => {
  for (const d of ["gmail.com", "yandex.ru", "mail.ru", "outlook.com", "icloud.com", "proton.me"]) {
    assert.equal(isPublicEmailProvider(d), true, `${d} should be public`);
  }
});

test("public provider matching is case-insensitive", () => {
  assert.equal(isPublicEmailProvider("GMAIL.COM"), true);
});

test("domainOf refuses anything that is not exactly local@domain", () => {
  // Taking split("@")[1] here would return "acme.com" and hand an outsider a
  // company workspace.
  assert.equal(domainOf("dana@acme.com@evil.com"), "");
  assert.equal(domainOf("dana@evil.com@acme.com"), "");
  assert.equal(domainOf("no-at-sign"), "");
  assert.equal(domainOf("@acme.com"), "");
  assert.equal(domainOf("dana@"), "");
  assert.equal(domainOf("dana@acme.com."), "");
  assert.equal(domainOf("dana@localhost"), "");
  assert.equal(domainOf("Dana@Acme.COM"), "acme.com");
});

// normalizeDomain — the value an app's "anyone at acme.com" rule is stored under.

test("normalizeDomain accepts the three spellings people type", () => {
  for (const typed of ["acme.com", "@acme.com", "dana@acme.com", "  @ACME.com  "]) {
    assert.equal(normalizeDomain(typed), "acme.com", `${JSON.stringify(typed)} is acme.com`);
  }
});

// The address routes to evil.com, so it must not become a rule for acme.com.
test("normalizeDomain refuses an address with two @", () => {
  assert.equal(normalizeDomain("dana@acme.com@evil.com"), "");
});

test("normalizeDomain refuses what is not a domain", () => {
  for (const bad of ["", "   ", "acme", "acme.", ".ai", "ac me.com", "acme..com", "-acme.com", "luwo-.ai", "https://acme.com", "acme.com/apps"]) {
    assert.equal(normalizeDomain(bad), "", `${JSON.stringify(bad)} is not a domain`);
  }
});

// "*" is how the sign-in allowlist spells "everyone". An app that means everyone
// is `public` — which is counted and capped — so it must not be spellable here.
test("normalizeDomain refuses a wildcard", () => {
  for (const bad of ["*", "*.acme.com", "@*"]) {
    assert.equal(normalizeDomain(bad), "", `${JSON.stringify(bad)} is not a domain`);
  }
});

test("normalizeDomain refuses a hostname longer than 253 characters", () => {
  assert.equal(normalizeDomain(`${"a".repeat(250)}.com`), "");
});
