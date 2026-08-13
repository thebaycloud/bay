import { test } from "node:test";
import assert from "node:assert/strict";
import { previousReleaseId } from "../lib/rollback";

const R = (id: number, version: number) => ({ id, version });

test("rolling back goes to the version before the one that is desired", () => {
  // Not "the highest version that is not current". Relative to DESIRED, because
  // an app that has already rolled back is asked for an older release while a
  // newer one still exists in the table — and rolling back again from there has
  // to keep going backwards rather than jumping to the newest.
  const releases = [R(10, 1), R(11, 2), R(12, 3)];
  assert.equal(previousReleaseId(releases, 12), 11);
  assert.equal(previousReleaseId(releases, 11), 10);
});

test("the earliest release has nothing behind it", () => {
  // The honest answer is "no", not "the newest". A rollback that silently rolls
  // FORWARD is the worst possible reading of the word.
  assert.equal(previousReleaseId([R(10, 1), R(11, 2)], 10), null);
});

test("an app with no desired release has nothing to roll back", () => {
  // `desired_release` is null for an app that was never placed, and for one that
  // has been withdrawn. Neither has a previous version to return to.
  assert.equal(previousReleaseId([R(10, 1)], null), null);
  assert.equal(previousReleaseId([], null), null);
});

test("a desired release the table does not contain is refused, not guessed", () => {
  // Cannot happen through the foreign key, and is still not answered by picking
  // something plausible: without knowing WHERE the app is in its history there
  // is no "previous", and the newest would be a roll forward wearing the name.
  assert.equal(previousReleaseId([R(10, 1), R(11, 2)], 99), null);
});

test("versions order the history, not ids", () => {
  // `version` is per app and assigned inside the INSERT; `id` is a global
  // sequence shared by every app. Two deploys of different apps interleave, so
  // ids of one app's releases are not contiguous and their ORDER can only be
  // trusted through `version`.
  const releases = [R(500, 1), R(3, 2), R(900, 3)];
  assert.equal(previousReleaseId(releases, 900), 3);
  assert.equal(previousReleaseId(releases, 3), 500);
});
