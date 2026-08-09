// services/proxy/src/builds.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { linesGone } from "./builds";

const DAY = 86_400_000;

test("a build older than the retention window has no narration left", () => {
  // pruneEvents(days = 7) runs at the start of every deploy, so the lines of an
  // old build are genuinely deleted. The tick and the outcome survive. Rendering
  // that as an empty list would read as "nothing happened", which is the exact
  // lie `since` exists to prevent elsewhere in this service.
  const now = Date.UTC(2026, 7, 9);
  assert.equal(linesGone(now - 8 * DAY, now), true);
  assert.equal(linesGone(now - 6 * DAY, now), false);
});

test("the boundary belongs to the side that still has lines", () => {
  const now = Date.UTC(2026, 7, 9);
  assert.equal(linesGone(now - 7 * DAY + 1000, now), false);
});
