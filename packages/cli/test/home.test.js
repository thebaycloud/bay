"use strict";
/**
 * The rename's one dangerous edge: a CLI that comes up signed out because it
 * stopped looking where the token is.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { configDirIn, envVarFrom } = require("../lib/home");

const dirs = (...present) => (p) => present.includes(p);

test("an existing ~/.bay is used", () => {
  assert.equal(configDirIn("/home/ada", dirs("/home/ada/.bay"), path.join), "/home/ada/.bay");
});

test("a user who only has the old directory stays signed in", () => {
  assert.equal(configDirIn("/home/ada", dirs("/home/ada/.supersonic"), path.join), "/home/ada/.supersonic");
});

test("a fresh machine gets the new name, never the old one", () => {
  assert.equal(configDirIn("/home/ada", dirs(), path.join), "/home/ada/.bay");
});

test("with both present the new one wins, and nothing is merged", () => {
  assert.equal(
    configDirIn("/home/ada", dirs("/home/ada/.bay", "/home/ada/.supersonic"), path.join),
    "/home/ada/.bay",
  );
});

test("the old variables still authenticate", () => {
  assert.equal(envVarFrom({ SUPERSONIC_TOKEN: "ss_old" }, "TOKEN"), "ss_old");
  assert.equal(envVarFrom({ BAY_TOKEN: "ss_new" }, "TOKEN"), "ss_new");
});

test("the new variable wins when both are exported", () => {
  assert.equal(envVarFrom({ BAY_URL: "https://new", SUPERSONIC_URL: "https://old" }, "URL"), "https://new");
});

test("unset, empty and whitespace are all unset", () => {
  assert.equal(envVarFrom({}, "TOKEN"), "");
  assert.equal(envVarFrom({ BAY_TOKEN: "" }, "TOKEN"), "");
  assert.equal(envVarFrom({ BAY_TOKEN: "  " }, "TOKEN"), "");
  // An empty BAY_ must not shadow a real SUPERSONIC_ — that is the shape of an
  // exported-but-never-assigned variable, and it would sign the user out.
  assert.equal(envVarFrom({ BAY_TOKEN: "", SUPERSONIC_TOKEN: "ss_old" }, "TOKEN"), "ss_old");
});
