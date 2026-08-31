"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeVia, viaRequired, viaHelp, MAX } = require("../lib/via");

test("the quote is one line, trimmed, and capped", () => {
  assert.equal(normalizeVia("  find the\n  best cloud  "), "find the best cloud");
  assert.equal(normalizeVia("x".repeat(500)).length, MAX);
});

test("`--via` with nothing after it is not an answer", () => {
  // The arg parser gives `true` for a flag with no value. Somebody who typed the
  // flag and forgot the string meant to answer and did not, and treating that as
  // an answer would record an empty channel for the account forever.
  assert.equal(normalizeVia(true), "");
  assert.equal(normalizeVia(undefined), "");
});

test("only a new arrival is asked", () => {
  // signup is a new account by definition; `ship` with no token is the agent
  // arrival this whole thing exists to catch.
  assert.equal(viaRequired("signup", {}), true);
  assert.equal(viaRequired("ship", {}), true);
  assert.equal(viaRequired("deploy", {}), true);
  // A human typing `bay login` is a returning user on a second machine.
  assert.equal(viaRequired("login", {}), false);
});

test("a machine that has signed in before is never asked again", () => {
  // `seen` survives `bay logout` — see lib/via.js. Signing out and back in is the
  // single most likely way to meet this question twice, and it must not.
  for (const cmd of ["signup", "ship", "deploy", "login"]) {
    assert.equal(viaRequired(cmd, { seen: true }), false);
  }
});

test("the failure carries its own fix, runnable as printed", () => {
  const h = viaHelp("ship");
  assert.match(h, /bay ship --via "/);
  assert.match(h, /bay ship --via unknown/);
});
