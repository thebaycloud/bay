"use strict";
/**
 * Reading a share argument, which is the one place in this CLI where the wrong
 * reading is quiet.
 *
 * `share app add acme.com` means "everyone at acme.com". If that were read as an
 * email address the server would refuse it and the user would see why. The
 * dangerous direction is the other one — a person's address read as a company
 * rule would open the app to a whole domain and print a success line, so the
 * shape test is written down here rather than left to the server.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseShare, audienceOf, shareBody } = require("../lib/share-args");

test("no verb is a question, not a change", () => {
  assert.deepEqual(parseShare([]), { kind: "show" });
  assert.deepEqual(parseShare(undefined), { kind: "show" });
});

test("the three visibilities are recognised, and nothing else is", () => {
  for (const v of ["private", "shared", "public"]) {
    assert.deepEqual(parseShare([v]), { kind: "visibility", visibility: v });
  }
  assert.deepEqual(parseShare(["PUBLIC"]), { kind: "visibility", visibility: "public" });
  assert.equal(parseShare(["open"]).kind, "error");
});

test("an address is a person and a domain is a rule", () => {
  assert.deepEqual(parseShare(["add", "ada@acme.com"]), { kind: "add", audience: "email", value: "ada@acme.com" });
  assert.deepEqual(parseShare(["add", "@acme.com"]), { kind: "add", audience: "domain", value: "acme.com" });
  // The @ is how people write a rule, not something the parser needs.
  assert.deepEqual(parseShare(["add", "acme.com"]), { kind: "add", audience: "domain", value: "acme.com" });
  assert.deepEqual(parseShare(["remove", "Ada@Acme.com"]), { kind: "remove", audience: "email", value: "ada@acme.com" });
  assert.deepEqual(parseShare(["rm", "@acme.co.uk"]), { kind: "remove", audience: "domain", value: "acme.co.uk" });
});

test("a word that is neither is refused rather than guessed at", () => {
  for (const bad of ["ada", "localhost", "@", "ada@", "@.com", "a b@c.com"]) {
    assert.equal(parseShare(["add", bad]).kind, "error", `${bad} should not parse`);
  }
  // RFC 5321's 254-character mailbox limit, so an address that could never be
  // delivered to is refused here rather than in a 400 from the server.
  assert.equal(audienceOf("a".repeat(250) + "@acme.com"), null);
});

test("add and remove need a target", () => {
  assert.equal(parseShare(["add"]).kind, "error");
  assert.match(parseShare(["remove"]).why, /usage/);
});

test("the body names the field the share route reads", () => {
  assert.deepEqual(shareBody({ kind: "add", audience: "email", value: "ada@acme.com" }), { addEmail: "ada@acme.com" });
  assert.deepEqual(shareBody({ kind: "add", audience: "domain", value: "acme.com" }), { addDomain: "acme.com" });
  assert.deepEqual(shareBody({ kind: "remove", audience: "email", value: "ada@acme.com" }), { removeEmail: "ada@acme.com" });
  assert.deepEqual(shareBody({ kind: "remove", audience: "domain", value: "acme.com" }), { removeDomain: "acme.com" });
});
