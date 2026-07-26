import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowed, type AllowEntry } from "../lib/allowlist";

const entries: AllowEntry[] = [
  { email: null, domain: "luwo.ai" },
  { email: null, domain: "supersonic.cv" },
  { email: "arsenfounder@gmail.com", domain: null },
];

test("an individually listed address is allowed", () => {
  assert.equal(isAllowed("arsenfounder@gmail.com", entries), true);
});

test("matching is case-insensitive and tolerates whitespace", () => {
  assert.equal(isAllowed("  ArsenFounder@Gmail.COM  ", entries), true);
  assert.equal(isAllowed("BORIS@LUWO.AI", entries), true);
});

test("any address on a listed domain is allowed", () => {
  assert.equal(isAllowed("anyone@luwo.ai", entries), true);
  assert.equal(isAllowed("someone@supersonic.cv", entries), true);
});

test("an address on an unlisted domain is denied", () => {
  assert.equal(isAllowed("boris@acme.com", entries), false);
});

test("an unlisted gmail address is denied even though another gmail is listed", () => {
  assert.equal(isAllowed("stranger@gmail.com", entries), false);
});

test("a lookalike domain does not match", () => {
  // The bug an endsWith implementation would have.
  assert.equal(isAllowed("boris@evil-luwo.ai", entries), false);
  assert.equal(isAllowed("boris@luwo.ai.evil.com", entries), false);
});

test("malformed addresses are denied", () => {
  for (const bad of ["", "   ", "no-at-sign", "@luwo.ai", "boris@"]) {
    assert.equal(isAllowed(bad, entries), false, `${JSON.stringify(bad)} should be denied`);
  }
});

test("an empty allowlist denies everyone", () => {
  assert.equal(isAllowed("arsenfounder@gmail.com", []), false);
});
