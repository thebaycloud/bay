import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RAIL_FOR_STAGE, UNMAPPED_STAGES, drive, railIndex, START } from "../lib/deploy-film";
import { ALL_STAGES } from "../lib/stage-names";

/**
 * The film is a claim about what the deploy is doing, so the only thing worth
 * testing about it is whether that claim can go wrong. It can go wrong in
 * exactly three ways: a stage nothing shows, a cut that happens without the
 * deploy asking for it, and a film that runs backwards.
 */

test("every stage the deploy can write has a shot", () => {
  // A new stage name with no rail is not a crash — the film simply never cuts
  // for it — which is the quiet failure worth a test rather than a comment. It
  // would show up as a deploy that appears to stall on the previous beat for
  // however long the new stage takes.
  assert.deepEqual(UNMAPPED_STAGES, [], `these stages have no shot: ${UNMAPPED_STAGES.join(", ")}`);
  for (const stage of ALL_STAGES) assert.ok(RAIL_FOR_STAGE[stage], `"${stage}" has no rail`);
});

test("the rails are rails the film actually has", () => {
  // The mapping's other half: a rail the picture does not know is as invisible
  // as no rail at all, and the picture is JavaScript we do not typecheck. Read
  // out of the film's own STAGE_NAME table, which is where its beats are named.
  const film = readFileSync(join(__dirname, "..", "components/film/ship-it.js"), "utf8");
  const table = film.slice(film.indexOf("const STAGE_NAME="), film.indexOf("let STAGES=[]"));
  const known = new Set([...table.matchAll(/"([a-z-]+)":\[/g)].map((m) => m[1]));
  assert.ok(known.size >= 12, `only found ${known.size} rails in the film — the extractor is not matching`);
  for (const rail of new Set(Object.values(RAIL_FOR_STAGE))) {
    assert.ok(known.has(rail), `the film has no "${rail}" beat`);
  }
});

test("a stage start is a cut; a stage end is not", () => {
  const s1 = drive(START, { type: "stage", stage: "clone", phase: "start" });
  assert.equal(s1.rail, "clone");
  // `end` says a thing finished, and there is nothing to cut to on that news.
  const s2 = drive(s1, { type: "stage", stage: "clone", phase: "end", outcome: "ok" });
  assert.equal(s2.rail, "clone");
});

test("the handoff is one beat, however many stages it is", () => {
  let s = START;
  for (const stage of ["job-launch", "job-import", "job-cold-start", "run-fetch"]) {
    s = drive(s, { type: "stage", stage, phase: "start" });
    assert.equal(s.rail, "dispatch");
  }
});

test("the handoff cuts on its end, because it has no start to cut on", () => {
  // Those four stages are reconstructed after the fact by a process that did
  // not exist while they were running, so they reach the stream as four `end`s
  // and nothing else. Cutting only on starts left the film sitting on its first
  // shot for the whole dark half of the deploy — which, on a cold job, is a
  // minute and a half of a picture that appears to have frozen.
  const s = drive(START, { type: "stage", stage: "job-launch", phase: "end", outcome: "ok" });
  assert.equal(s.rail, "dispatch");

  // …and a stage that DOES announce its start is not double-cut by its end: it
  // would take the film past a beat the deploy is still working on.
  let t = drive(START, { type: "stage", stage: "clone", phase: "start" });
  t = drive(t, { type: "stage", stage: "clone", phase: "end", outcome: "ok" });
  assert.equal(t.rail, "clone");
});

test("a failed build loads the cut with the break in it", () => {
  let s = drive(START, { type: "stage", stage: "build", phase: "start" });
  assert.equal(s.scenario, "container");
  s = drive(s, { type: "stage", stage: "build", phase: "end", outcome: "failed" });
  assert.equal(s.scenario, "repair");
  assert.equal(s.broke, true);
  // Back to the build beat, because that is where the hull lets go — cutting
  // straight to the repair drone would skip the only shot that says what
  // happened.
  assert.equal(s.rail, "build");
  s = drive(s, { type: "stage", stage: "repair-agent", phase: "start" });
  assert.equal(s.rail, "repair-agent");
});

test("a build that succeeds never loads the repair cut", () => {
  let s = drive(START, { type: "stage", stage: "build", phase: "start" });
  s = drive(s, { type: "stage", stage: "build", phase: "end", outcome: "ok" });
  assert.equal(s.scenario, "container");
  assert.equal(s.broke, false);
});

test("a static deploy is a different film, decided off the detector", () => {
  const s = drive(START, { type: "detected", stack: { framework: "vite", language: "static" } });
  assert.equal(s.scenario, "static");
  // …and a prebuilt upload, which has no detector output of its own.
  assert.equal(drive(START, { type: "detected", stack: { framework: "prebuilt", language: "static" } }).scenario, "static");
  assert.equal(drive(START, { type: "detected", stack: { framework: "next", language: "typescript" } }).scenario, "container");
});

test("the detector cannot undo a break", () => {
  // Ordering insurance: `detected` arrives long before a build fails, but a
  // reconnecting client replays the whole log from event 0 and nothing
  // guarantees which fold sees what first.
  const broken = { ...START, scenario: "repair" as const, broke: true };
  assert.equal(drive(broken, { type: "detected", stack: { language: "static" } }).scenario, "repair");
});

test("live is the last shot; a failure is not", () => {
  const live = drive(START, { type: "done", slug: "storefront", url: "https://storefront.supersonic.cv" });
  assert.equal(live.rail, "done");
  assert.equal(live.url, "https://storefront.supersonic.cv");
  assert.equal(live.done, true);
  assert.equal(live.failed, false);

  // A deploy that failed holds wherever it stopped. There is no sunrise.
  const dead = drive(drive(START, { type: "stage", stage: "build", phase: "start" }), { type: "error", message: "nope" });
  assert.equal(dead.rail, "build");
  assert.equal(dead.failed, true);
});

test("noise on the stream moves nothing", () => {
  const s = drive(START, { type: "stage", stage: "clone", phase: "start" });
  for (const e of [{ type: "log", line: "npm ci" }, { type: "patch", patch: "x" }, {}, null, "nonsense"]) {
    assert.deepEqual(drive(s, e), s);
  }
  // A stage the film has no rail for — one added later, or a typo — is ignored
  // rather than treated as a cut to nowhere.
  assert.deepEqual(drive(s, { type: "stage", stage: "smelting", phase: "start" }), s);
});

test("the film only ever runs forward, and lands on the second build", () => {
  // The repair cut's rails, as the film reports them.
  const rails = ["run-record", "dispatch", "clone", "detect", "plan", "render",
    "build", "repair-agent", "build", "upload", "release", "fleet", "verify", "done"];
  assert.equal(railIndex(rails, "build", 0), 6);
  // After the agent, the next `build` is the rebuild — not a jump back to the
  // wreck.
  assert.equal(railIndex(rails, "build", 8), 8);
  assert.equal(railIndex(rails, "clone", 6), -1, "a stage already passed is not replayed");
  assert.equal(railIndex(rails, "smelting", 0), -1);
});

test("a cut the loaded film does not have is not an error", () => {
  // `deploy` is the static cut's beat. The container cut has no such rail, and
  // the container lane emits `deploy` anyway — it is the span around the whole
  // activation. It has to be a no-op, not a wrong cut.
  const container = ["clone", "build", "upload", "release", "fleet", "verify", "done"];
  assert.equal(railIndex(container, "deploy", 0), -1);
  assert.equal(RAIL_FOR_STAGE["deploy"], "deploy");
});
