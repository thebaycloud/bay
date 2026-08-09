"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { whoHeader } = require("../lib/who");

test("the CLI declares an agent only when told to", () => {
  // SUPERSONIC_WHO is the only input. There is deliberately no TTY check: CI has
  // no TTY, and reporting "agent" there would be a confident lie in the one
  // field this whole surface exists to show.
  assert.equal(whoHeader({ SUPERSONIC_WHO: "agent" }), "agent");
  assert.equal(whoHeader({ SUPERSONIC_WHO: "you" }), "you");
  assert.equal(whoHeader({ SUPERSONIC_WHO: " Platform " }), "platform");
});

test("an undeclared shipper is someone, and CI is not an agent", () => {
  assert.equal(whoHeader({}), "someone");
  assert.equal(whoHeader({ CI: "true" }), "someone");
  assert.equal(whoHeader({ SUPERSONIC_WHO: "robot" }), "someone");
});
