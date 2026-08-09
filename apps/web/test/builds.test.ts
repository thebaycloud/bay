import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseWho, buildStartSql, buildFinishSql } from "../lib/builds";

test("an undeclared actor is someone, never a guess", () => {
  // The whole point of the field. A wrong name here is worse than no name:
  // the dashboard's one claim over Render's is that it says who acted.
  assert.equal(normaliseWho(undefined), "someone");
  assert.equal(normaliseWho(null), "someone");
  assert.equal(normaliseWho(""), "someone");
});

test("only the three declared actors are accepted", () => {
  assert.equal(normaliseWho("you"), "you");
  assert.equal(normaliseWho("agent"), "agent");
  assert.equal(normaliseWho("platform"), "platform");
  assert.equal(normaliseWho("  Agent "), "agent");
});

test("anything else falls to someone rather than being interpreted", () => {
  // "ci" is the exact case that tempts inference. It is not one of the three,
  // so it is someone — we do not decide that CI means an agent.
  assert.equal(normaliseWho("ci"), "someone");
  assert.equal(normaliseWho("human"), "someone");
  assert.equal(normaliseWho("robot"), "someone");
});

test("a build is recorded under its run id, with who normalised", () => {
  // The SQL is thin; what is worth testing is that an undeclared actor reaches
  // the database as `someone` rather than as an empty string or a NULL that the
  // CHECK constraint would reject at 3am during a deploy.
  const { text, values } = buildStartSql("run-1", "lilna", "ci");
  assert.match(text, /INSERT INTO builds/);
  assert.deepEqual(values, ["run-1", "lilna", "someone"]);
});

test("finishing a build records its outcome and nothing else", () => {
  const { text, values } = buildFinishSql("run-1", "failed");
  assert.match(text, /UPDATE builds/);
  assert.deepEqual(values, ["run-1", "failed"]);
});
