import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseWho } from "../lib/builds";

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
