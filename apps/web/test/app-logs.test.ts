import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFailed } from "../lib/app-logs";

test("a build still in flight is not a failed build", () => {
  // Watching y7ux3 build on 1 Aug printed forty lines of `Pulling fs layer` and
  // `Pull complete` at ERROR severity, because the build was WORKING and the old
  // test was `status !== "SUCCESS"`. A user filtering for the problem found the
  // entire healthy log.
  for (const s of ["WORKING", "QUEUED", "PENDING", "SUCCESS", ""]) {
    assert.equal(buildFailed(s), false, `${s || "(empty)"} must not read as failure`);
  }
});

test("a build that is over and did not work is a failed build", () => {
  for (const s of ["FAILURE", "INTERNAL_ERROR", "TIMEOUT", "CANCELLED", "EXPIRED"]) {
    assert.equal(buildFailed(s), true, `${s} must read as failure`);
  }
});

test("status matching is case-insensitive and survives junk", () => {
  assert.equal(buildFailed("failure"), true);
  assert.equal(buildFailed("Timeout"), true);
  assert.equal(buildFailed("banana"), false);
});
