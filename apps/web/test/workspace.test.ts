import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublicEmailProvider, domainOf, normalizeDomain } from "../lib/workspace";

test("domainOf lowercases and takes the part after @", () => {
  assert.equal(domainOf("Boris@Acme.COM"), "acme.com");
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
  // Taking split("@")[1] here would return "luwo.ai" and hand an outsider a
  // company workspace.
  assert.equal(domainOf("boris@luwo.ai@evil.com"), "");
  assert.equal(domainOf("boris@evil.com@luwo.ai"), "");
  assert.equal(domainOf("no-at-sign"), "");
  assert.equal(domainOf("@luwo.ai"), "");
  assert.equal(domainOf("boris@"), "");
  assert.equal(domainOf("boris@luwo.ai."), "");
  assert.equal(domainOf("boris@localhost"), "");
  assert.equal(domainOf("Boris@Luwo.AI"), "luwo.ai");
});

// normalizeDomain — the value an app's "anyone at luwo.ai" rule is stored under.

test("normalizeDomain accepts the three spellings people type", () => {
  for (const typed of ["luwo.ai", "@luwo.ai", "boris@luwo.ai", "  @LUWO.ai  "]) {
    assert.equal(normalizeDomain(typed), "luwo.ai", `${JSON.stringify(typed)} is luwo.ai`);
  }
});

// The address routes to evil.com, so it must not become a rule for luwo.ai.
test("normalizeDomain refuses an address with two @", () => {
  assert.equal(normalizeDomain("boris@luwo.ai@evil.com"), "");
});

test("normalizeDomain refuses what is not a domain", () => {
  for (const bad of ["", "   ", "luwo", "luwo.", ".ai", "lu wo.ai", "luwo..ai", "-luwo.ai", "luwo-.ai", "https://luwo.ai", "luwo.ai/apps"]) {
    assert.equal(normalizeDomain(bad), "", `${JSON.stringify(bad)} is not a domain`);
  }
});

// "*" is how the sign-in allowlist spells "everyone". An app that means everyone
// is `public` — which is counted and capped — so it must not be spellable here.
test("normalizeDomain refuses a wildcard", () => {
  for (const bad of ["*", "*.luwo.ai", "@*"]) {
    assert.equal(normalizeDomain(bad), "", `${JSON.stringify(bad)} is not a domain`);
  }
});

test("normalizeDomain refuses a hostname longer than 253 characters", () => {
  assert.equal(normalizeDomain(`${"a".repeat(250)}.com`), "");
});
