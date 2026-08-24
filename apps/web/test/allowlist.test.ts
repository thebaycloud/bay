import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowed, type AllowEntry } from "../lib/allowlist";

const entries: AllowEntry[] = [
  { email: null, domain: "example.com" },
  { email: null, domain: "supersonic.cv" },
  { email: "owner@example.com", domain: null },
];

test("an individually listed address is allowed", () => {
  assert.equal(isAllowed("owner@example.com", entries), true);
});

test("matching is case-insensitive and tolerates whitespace", () => {
  assert.equal(isAllowed("  Owner@Example.COM  ", entries), true);
  assert.equal(isAllowed("DANA@EXAMPLE.COM", entries), true);
});

test("any address on a listed domain is allowed", () => {
  assert.equal(isAllowed("anyone@example.com", entries), true);
  assert.equal(isAllowed("someone@supersonic.cv", entries), true);
});

test("an address on an unlisted domain is denied", () => {
  assert.equal(isAllowed("dana@acme.com", entries), false);
});

test("an unlisted gmail address is denied even though another gmail is listed", () => {
  assert.equal(isAllowed("stranger@gmail.com", entries), false);
});

test("a lookalike domain does not match", () => {
  // The bug an endsWith implementation would have.
  assert.equal(isAllowed("dana@evil-acme.com", entries), false);
  assert.equal(isAllowed("dana@acme.com.evil.com", entries), false);
});

test("malformed addresses are denied", () => {
  for (const bad of ["", "   ", "no-at-sign", "@acme.com", "dana@"]) {
    assert.equal(isAllowed(bad, entries), false, `${JSON.stringify(bad)} should be denied`);
  }
});

test("an empty allowlist denies everyone", () => {
  assert.equal(isAllowed("owner@example.com", []), false);
});

// The bypass this file exists to prevent: reading the second "@" field instead
// of requiring exactly one made dana@acme.com@evil.com look like acme.com, while
// mail actually routes to evil.com.
test("an address with more than one @ is denied", () => {
  for (const bad of [
    "dana@acme.com@evil.com",
    "dana@evil.com@acme.com",
    "owner@example.com@evil.com",
    "a@b@c@acme.com",
  ]) {
    assert.equal(isAllowed(bad, entries), false, `${bad} should be denied`);
  }
});

test("addresses with an undeliverable domain are denied", () => {
  for (const bad of ["dana@acme.com.", "dana@.acme.com", "dana@localhost", "dana@"]) {
    assert.equal(isAllowed(bad, entries), false, `${bad} should be denied`);
  }
});
