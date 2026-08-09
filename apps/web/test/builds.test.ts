import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normaliseWho, buildStartSql, buildFinishSql, watchOutcome } from "../lib/builds";

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

test("a build that said nothing about its ending is failed, never ok", () => {
  // The default has to be the answer that gets corrected if it is wrong. A run
  // that emitted neither `done` nor `error` did not succeed, and recording `ok`
  // there would put a green tick on the app's timeline that nothing else in the
  // system disagrees with.
  assert.equal(watchOutcome().outcome, "failed");
});

test("the deploy's own narration decides the outcome", () => {
  const ok = watchOutcome();
  ok.saw({ type: "start", slug: "lilna" });
  ok.saw({ type: "log", line: "building…" });
  ok.saw({ type: "done", slug: "lilna", url: "https://lilna.supersonic.cv" });
  assert.equal(ok.outcome, "ok");

  // The dominant failure path: runDeploy RETURNS after sending `error`, so the
  // job's catch never runs and the call it awaited resolves exactly as it does
  // on success. Only the event tells the two apart.
  const bad = watchOutcome();
  bad.saw({ type: "start", slug: "lilna" });
  bad.saw({ type: "error", message: "Build failed" });
  assert.equal(bad.outcome, "failed");

  // And nothing that is not one of those two moves it.
  const noise = watchOutcome();
  noise.saw({ type: "patch", patch: "diff --git" });
  noise.saw(null);
  noise.saw("not an object");
  assert.equal(noise.outcome, "failed");
});

test("the deploy job records the build's ending beside the run's", () => {
  // The defect this covers cannot be reached by a unit test: scripts/deploy-job.ts
  // runs main() at import, and every ending it has is inside one finally. What is
  // being defended is that the finally has BOTH endings in it — for the whole of
  // this branch it had only finishRun, so every build in production read
  // `ended_at: null, outcome: null` forever. Source-level, like stages.test.ts's
  // emitter scan, and for the same reason.
  const src = readFileSync(join(__dirname, "..", "scripts", "deploy-job.ts"), "utf8");
  assert.match(src, /await finishRun\(runId\);\s*(?:\/\/[^\n]*\n\s*)*await finishBuild\(runId, watch\.outcome\);/,
    "deploy-job must finish the build wherever it finishes the run");
  // The outcome must come from what the deploy said, not from reaching the end
  // of the function: `runDeploy` resolves the same way whether it shipped or not.
  assert.match(src, /watchOutcome\(\)/);
});
