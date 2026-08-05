import { test } from "node:test";
import assert from "node:assert/strict";
import { ownedResourceNames } from "../lib/gcloud";

/**
 * Which resources a delete may take with it.
 *
 * Every case here is a way the previous rule — a bare `startsWith(slug + "-")` —
 * either destroyed something it did not own or missed something it did.
 */

test("a delete does not take another app with it", () => {
  // The one that was live. On 5 Aug the platform held `subio` and `subio-2`,
  // both serving, same owner, different apps. Deleting the first ran
  // `run services delete subio-2` — no warning, no record, and the only trace
  // would have been a customer noticing their other app had stopped.
  const others = new Set(["subio-2", "anatf"]);
  const names = ["subio-2", "anatf", "subio-api"];

  const owned = ownedResourceNames("subio", names, others);

  assert.deepEqual(owned, ["subio-api"], "subio-2 is an app, not subio's sibling");
});

test("the app's own siblings are still found", () => {
  // The fix must not become "delete nothing". A multi-service app really does
  // name its parts this way, and leaving them behind is the defect the prefix
  // match was written for: services billing under the name of an app that no
  // longer exists.
  const owned = ownedResourceNames("foo", ["foo-api", "foo-worker", "foo-bot", "foo-nightly"], new Set());
  assert.deepEqual(owned.sort(), ["foo-api", "foo-bot", "foo-nightly", "foo-worker"]);
});

test("the app's own name is never in the list", () => {
  // The primary is deleted by name, before this runs. Returning it here would
  // delete it twice — harmless for a service, and not harmless for the
  // second delete's error handling to start swallowing.
  assert.deepEqual(ownedResourceNames("foo", ["foo"], new Set()), []);
});

test("an unrelated app that merely starts with the same letters is untouched", () => {
  // `foobar` is not `foo-`anything. Only the hyphen makes a sibling, which is
  // what the naming scheme actually guarantees.
  assert.deepEqual(ownedResourceNames("foo", ["foobar", "foobar-api"], new Set()), []);
});

test("blank lines from gcloud output are dropped", () => {
  // `--format=value(...)` ends with a newline, so the last element is always
  // empty; an empty name reaching `gcloud ... delete ""` is an error message
  // in a log nobody reads.
  assert.deepEqual(ownedResourceNames("foo", ["foo-api", "", "  ", "\n"], new Set()), ["foo-api"]);
});

test("names arrive untrimmed and are matched anyway", () => {
  assert.deepEqual(ownedResourceNames("foo", ["  foo-api  "], new Set()), ["foo-api"]);
});

test("with no knowledge of other apps it falls back to the old behaviour", () => {
  // otherAppSlugs returns an empty set when the database cannot be reached.
  // That must degrade to what this did before — deleting siblings by prefix —
  // rather than to deleting nothing, which would silently start leaving
  // resources behind on every failed lookup.
  assert.deepEqual(ownedResourceNames("subio", ["subio-2", "subio-api"], new Set()).sort(), ["subio-2", "subio-api"]);
});
