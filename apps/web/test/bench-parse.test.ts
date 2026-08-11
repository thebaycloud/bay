/**
 * The tape measure, checked against the thing it measures.
 *
 * These two functions are the whole seam between a deploy happening and a row
 * being written, and on 10 Aug the first of them was wrong in the most expensive
 * way available: it read the CLI's pretty-printed JSON line by line, found no
 * line that parsed, and recorded every deploy in the batch as a failure with a
 * null slug and no error. An hour of real builds produced ten rows that said
 * nothing, and the apps leaked because the harness never learned their names.
 *
 * So the fixtures below are not invented. They are the shapes
 * `packages/cli/index.js` actually emits — `json()` is
 * `JSON.stringify(o, null, 2)`, `die()` writes `✗ …` to stderr and exits without
 * printing any JSON at all — and the point of pinning them here is that the next
 * change to either side breaks a test rather than a batch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { lastJsonObject, reserveLine } from "../bench/parse";

/** Exactly what the CLI prints on a deploy that went live. */
const LIVE = `▸ deploying from https://github.com/onlytenders/2048-in-react
⧗ deploying — your app will be live at https://ab3cd.supersonic.cv
  detected next
  building…
{
  "ok": true,
  "slug": "ab3cd",
  "url": "https://ab3cd.supersonic.cv",
  "runId": "run_01J8"
}`;

test("the CLI's pretty-printed result is read as one object", () => {
  assert.deepEqual(lastJsonObject(LIVE), {
    ok: true, slug: "ab3cd", url: "https://ab3cd.supersonic.cv", runId: "run_01J8",
  });
});

test("a single-line result is read too", () => {
  // The CLI is free to stop pretty-printing; that must not break this again in
  // the other direction.
  assert.deepEqual(lastJsonObject(`narration\n{"ok":false,"error":"nope"}`), { ok: false, error: "nope" });
});

test("the result wins over JSON-shaped narration before it", () => {
  const out = `{"ok":true,"slug":"decoy"}\nbuilding…\n{\n  "ok": false,\n  "slug": "real"\n}`;
  assert.deepEqual(lastJsonObject(out), { ok: false, slug: "real" });
});

test("a brace inside a log sentence is not the start of a result", () => {
  // Anchored on the line start precisely so this cannot be mistaken for JSON.
  assert.equal(lastJsonObject(`  warning: unexpected { in config\nstill building`), null);
});

test("output with no result at all is null, not a guess", () => {
  // What `die()` produces: a reason on stderr, no JSON, exit 1. The caller has
  // to be able to tell this apart from a result, because this is the case where
  // the row's error must come from the tail instead.
  assert.equal(lastJsonObject("✗ You already have 5 deploys building."), null);
});

test("an array is not a result", () => {
  assert.equal(lastJsonObject(`[1,2,3]`), null);
});

test("the reserve line yields the slug and the address whole", () => {
  const r = reserveLine("⧗ deploying — your app will be live at https://ab3cd.supersonic.cv");
  assert.deepEqual(r, { slug: "ab3cd", url: "https://ab3cd.supersonic.cv" });
});

test("trailing punctuation belongs to the sentence, not the address", () => {
  const r = reserveLine("⧗ deploying — your app will be live at https://ab3cd.supersonic.cv.");
  assert.equal(r?.url, "https://ab3cd.supersonic.cv");
});

test("a local run's address is read the same way", () => {
  // `--target local` points the same CLI at a control plane on this laptop, and
  // the slug still has to come out of it for cleanup to work.
  const r = reserveLine("⧗ deploying — your app will be live at http://xy12z.localhost:3000");
  assert.deepEqual(r, { slug: "xy12z", url: "http://xy12z.localhost:3000" });
});

test("any other line is not a reserve", () => {
  assert.equal(reserveLine("  detected next"), null);
  assert.equal(reserveLine("✓ build is live at https://ab3cd.supersonic.cv"), null);
});
