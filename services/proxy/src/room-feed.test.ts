import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, stepOf, type RoomStep } from "./room-feed";

// Every line below is a real one, taken from production `deploy_events`, with
// its observed frequency. The first version of classify() was written against
// imagined npm/docker output and put almost all of these in "work".
test("the pipeline's own vocabulary maps to movements", () => {
  assert.equal(classify("Unpacking your project…"), "unpack");                       // 89
  assert.equal(classify("Detecting stack…"), "detect");                              // 90
  assert.equal(classify("Detected Node · JavaScript (60%)"), "detect");              // 51
  assert.equal(classify("preparing…"), "prepare");                                   // 185
  assert.equal(classify("building…"), "build");                                      // 589
  assert.equal(classify("building api…"), "build");                                  // 53
  assert.equal(classify("Provisioning Postgres…"), "provision");                     // 45
  assert.equal(classify("deploying…"), "boot");                                      // 144
  assert.equal(classify("verifying the app responds…"), "boot");                     // 27
  assert.equal(classify("release runs on the node, before the app starts"), "release"); // 44
});

test("a build is not a download, however much it talks about images", () => {
  // The defect this replaced: `image` was tested before `build`, so the single
  // most important line in a deploy was drawn as a download.
  assert.equal(classify("Building an image on node 24 — platform default."), "build");
  assert.equal(classify("Building with layer cache (buildkit) — the first build warms it"), "build");
  // And the line that IS the base image arriving still reads as one.
  assert.equal(classify("Base pinned to us-central1-docker.pkg.dev/…/node:24 @ sha256:934240a…"), "pull");
});

test("the repair agent is its own actor, not a build step", () => {
  // `agent` is the second most common opening word in the whole table (368).
  assert.equal(classify("agent: rebuilding after the fix"), "repair");
  assert.equal(classify("Repair agent taking over"), "repair");
  // Even when its line also says "build", which several of them do.
  assert.equal(classify("agent is retrying the build"), "repair");
});

test("a line that says nothing recognisable is still a movement", () => {
  // One real line, one movement. An unclassifiable line still happened, so it
  // moves the agent — it just moves them generically rather than being dropped.
  assert.equal(classify("some tool nobody has heard of says hello"), "work");
  assert.equal(classify("Private by default — anyone opening this link has to sign in."), "work");
});

test("only events that happened on screen become steps", () => {
  assert.deepEqual(stepOf(7, { type: "log", line: "building…" }), {
    id: 7, kind: "build", text: "building…",
  });
  assert.deepEqual(stepOf(8, { type: "error", message: "exit code 1" }), {
    id: 8, kind: "broke", text: "exit code 1",
  });
  // Structure, not motion. The room must not move for these.
  assert.equal(stepOf(9, { type: "done", url: "https://x" }), null);
  assert.equal(stepOf(10, { type: "detected", lane: "fast" }), null);
  assert.equal(stepOf(11, { type: "patch", patch: "diff --git" }), null);
});

test("a blank line is not a movement", () => {
  assert.equal(stepOf(1, { type: "log", line: "   " }), null);
  assert.equal(stepOf(2, { type: "log", line: "" }), null);
});

test("a guest is not sent a build, redacted or otherwise", async () => {
  // This replaced `forGuest`, which handed a guest the movements and the stage
  // boundaries with the words stripped out. The words were never the whole
  // disclosure: the stages told anyone with the link how long this deploy was,
  // which part of it was running, how long it had been stuck there and whether
  // it had broken. Nothing goes to a guest now, and these are the two places
  // that has to hold.
  const { readFileSync } = await import("node:fs");
  const room = readFileSync(new URL("./room.ts", import.meta.url), "utf8");
  // The fan-out skips them...
  assert.match(room, /function broadcastSteps[\s\S]*?if \(!w\.owner\) continue;/);
  // ...and the stream is refused before a watcher is ever attached, so a guest
  // who requests /_room/events by hand gets nothing either.
  const serve = /export function serveRoomEvents[\s\S]*?\n}/.exec(room)?.[0] ?? "";
  assert.ok(serve, "serveRoomEvents not found");
  const gate = serve.indexOf("if (!owner)");
  const attach = serve.indexOf("watchers.add");
  assert.ok(gate >= 0, "serveRoomEvents does not check ownership");
  assert.ok(gate < attach, "ownership is checked after the watcher is attached");
});

test("quiet is rarer than the ordinary gap between build lines", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./room.ts", import.meta.url), "utf8");
  const ms = Number(/const QUIET_AFTER_MS = ([\d_]+)/.exec(src)?.[1].replace(/_/g, ""));
  // Measured over 7,556 gaps in production deploy_events: p50 2.9s, p90 8.0s.
  // A threshold at or under p90 fires during healthy builds, and a message that
  // appears during normal work stops meaning anything. It must clear p90 with
  // room to spare — the tail it exists for (cold start) is minutes, not seconds.
  assert.ok(ms > 8_000, `quiet at ${ms}ms trips inside the measured p90 gap of 8s`);
  assert.ok(ms >= 15_000, `quiet at ${ms}ms is too eager for a 2.9s median line rate`);
});

// Both found by classifying a real 26-line deploy of a Python app with a
// database — the first build long enough and varied enough to exercise the
// whole grammar. Neither was visible on the shorter Node deploys.
test("a finished image is a build, not the app starting", () => {
  // `built` is not matched by /\bbuild/ — buil+t against buil+d — so this line
  // fell through to `boot` on the word "deployed" later in it, and the most
  // consequential line in a deploy was drawn as the app coming up.
  assert.equal(
    classify('Built sha256:27108542e866… — deployed by digest, so "the new version" is a fact rather than a tag.'),
    "build",
  );
});

test("planning is working out what this is, not starting it", () => {
  // A bare `ready` in the boot test caught "Plan ready".
  assert.equal(classify("Plan ready: supersonic.json"), "detect");
  assert.equal(classify("Using supersonic.json — no planning needed"), "detect");
  assert.equal(classify("planner picked the fast lane"), "detect");
  // And the app actually answering is still boot.
  assert.equal(classify("Live at izuvx.supersonic.cv"), "boot");
  assert.equal(classify("verifying the app responds…"), "boot");
});

test("a database-backed deploy fills the room rather than the fallback", () => {
  // The real sequence, in order. Nine of these ten used to be generic walks.
  const real = [
    ["Unpacking your project…", "unpack"],
    ["Detecting stack…", "detect"],
    ["Detected Flask · Python (90%)", "detect"],
    ["Provision postgres (via psycopg)", "provision"],
    ["Provisioning Postgres…", "provision"],
    ["Database isolated — this app connects as app_izuvx", "provision"],
    ["Deploying izuvx to the fleet…", "boot"],
    ["release runs on the node, before the app starts", "release"],
    ["Building with layer cache (buildkit)", "build"],
    ["Live at izuvx.supersonic.cv", "boot"],
  ] as const;
  for (const [line, kind] of real) assert.equal(classify(line), kind, line);
});


test("a stage boundary comes through as a stage, not as a movement", () => {
  // The film needs the START of a stage, at the moment it happens. Until the
  // deploy began announcing these, the only record was deploy_stages — written
  // when a stage ENDS, which on `fleet` is about ninety seconds after the thing
  // it describes began.
  assert.deepEqual(stepOf(11, { type: "stage", stage: "fleet", phase: "start" }), {
    id: 11, kind: "stage", stage: "fleet", phase: "start", outcome: undefined,
  });
  assert.deepEqual(stepOf(12, { type: "stage", stage: "build", phase: "end", outcome: "failed" }), {
    id: 12, kind: "stage", stage: "build", phase: "end", outcome: "failed",
  });
  // A malformed one is not a step. The feed is read from a jsonb column, and
  // "some event that is nearly a stage" must not become a cut to nowhere.
  assert.equal(stepOf(13, { type: "stage" }), null);
});

test("the log's clock is the deploy's, not the reader's", async () => {
  // A room is routinely opened at minute four of a build. If the gutter counted
  // from when the tab did, the first line it showed would be captioned 0s — a
  // build four minutes old, labelled as having just started. So the offset is
  // computed against the run's own first event, in the query that reads it.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./room-feed.ts", import.meta.url), "utf8");
  assert.match(src, /SELECT MIN\(at\) FROM deploy_events WHERE run_id = \$1/);
  // Both readers label their rows: the tail a late arrival gets, and the pages
  // that follow it.
  for (const fn of ["stepsAfter", "tailSteps"]) {
    const body = new RegExp("export async function " + fn + "[\\s\\S]*?\\n}").exec(src)?.[0] ?? "";
    assert.ok(body, fn + " not found");
    assert.match(body, /t: Number\(row\.t\) \|\| 0/);
  }
});
