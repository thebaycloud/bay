import { test } from "node:test";
import assert from "node:assert/strict";
import { PartialPlan } from "../lib/opencode-deploy";

test("a partial plan carries the language the planner did settle", () => {
  // The whole point: `catch` used to receive a bare Error and the caller fell
  // back to a detector that had never read the repo. On 1 Aug that turned a
  // planner reading of pyproject.toml into a Node-runner deploy.
  const e = new PartialPlan({ language: "python" }, "planner returned no run command for a server app");
  assert.ok(e instanceof Error, "still an Error, so existing catch sites are unaffected");
  assert.ok(e instanceof PartialPlan);
  assert.equal(e.plan.language, "python");
  assert.equal(e.name, "PartialPlan");
  assert.match(e.message, /no run command/);
});

test("an ordinary planner failure is not a partial plan", () => {
  // "no usable JSON plan" salvages nothing — there was no language to keep — and
  // must not be mistaken for one, or the pipeline would read `undefined` as an
  // answer.
  const e = new Error("planner produced no usable JSON plan");
  assert.ok(!(e instanceof PartialPlan));
});
