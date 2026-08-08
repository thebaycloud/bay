import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, stepOf, forGuest, type RoomStep } from "./room-feed";

test("a build line becomes the movement it describes", () => {
  assert.equal(classify("Pulling image supersonic/runner:latest"), "pull");
  assert.equal(classify("added 214 packages in 9s"), "deps");
  assert.equal(classify("vite v5.4.2 building for production..."), "build");
  assert.equal(classify("Listening on port 8080"), "boot");
});

test("a line that says nothing recognisable is still a movement", () => {
  // The room's rule is one real line, one movement. An unclassifiable line is
  // still something that happened, so it moves the agent — it just moves them
  // generically rather than being dropped.
  assert.equal(classify("â”€â”€â”€â”€â”€â”€â”€"), "work");
  assert.equal(classify("some tool nobody has heard of says hello"), "work");
});

test("classification reads the whole line, not its first word", () => {
  assert.equal(classify("RUN npm ci --omit=dev"), "deps");
  assert.equal(classify("Step 4/9 : COPY . ."), "work");
});

test("only events that happened on screen become steps", () => {
  assert.deepEqual(stepOf(7, { type: "log", line: "added 3 packages" }), {
    id: 7, kind: "deps", text: "added 3 packages",
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
    { id: 1, kind: "deps", text: "npm ERR! /Users/someone/secret-project/src/keys.ts" },
    { id: 2, kind: "broke", text: "Error: ENOENT /home/build/app/.env.production" },
  ];
  const seen = forGuest(steps);
  assert.deepEqual(seen, [{ id: 1, kind: "deps" }, { id: 2, kind: "broke" }]);
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
