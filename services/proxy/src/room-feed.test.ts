import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, stepOf, forGuest, type RoomStep } from "./room-feed";

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

test("a guest gets the movement and never the words", () => {
  const steps: RoomStep[] = [
    { id: 1, kind: "prepare", text: "npm ERR! /Users/someone/secret-project/src/keys.ts" },
    { id: 2, kind: "broke", text: "Error: ENOENT /home/build/app/.env.production" },
  ];
  const seen = forGuest(steps);
  assert.deepEqual(seen, [{ id: 1, kind: "prepare" }, { id: 2, kind: "broke" }]);
  // The count is preserved: a guest sees the same amount of work happening.
  assert.equal(seen.length, steps.length);
  // And nothing carries text through by another name.
  assert.equal(JSON.stringify(seen).includes("secret-project"), false);
  assert.equal(JSON.stringify(seen).includes(".env"), false);
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
