import { test } from "node:test";
import assert from "node:assert/strict";
import { appLogFilter } from "../lib/log-filter";

test("asks both places at once", () => {
  const f = appLogFilter("a8ebb");
  assert.ok(f.includes("cloud_run_revision"), "the Cloud Run arm is missing");
  assert.ok(f.includes("gce_instance"), "the node arm is missing");
  assert.ok(f.includes(" OR "), "the two arms must be alternatives, not a conjunction");
});

test("both arms name the app", () => {
  // An arm that does not name the slug returns every app's output to whoever
  // asked about one — the worst possible failure for this function.
  const f = appLogFilter("a8ebb");
  const arms = f.split(" OR ");
  assert.equal(arms.length, 2, `expected two arms, got ${arms.length}`);
  for (const arm of arms) {
    assert.ok(arm.includes("a8ebb"), `an arm does not name the slug: ${arm}`);
  }
});

test("severity applies to the whole filter, not to one arm", () => {
  // Written as a trailing conjunct outside the parenthesised alternation. If it
  // landed inside one arm, errors from the other runtime would be silently
  // dropped — which is exactly the bug this function exists to prevent.
  const f = appLogFilter("a8ebb", { minSeverity: "ERROR" });
  assert.ok(f.includes("severity>=ERROR"), "severity is missing");
  assert.ok(
    f.trimEnd().endsWith("severity>=ERROR"),
    `severity must be the trailing conjunct, got: ${f}`
  );
});

test("no severity clause when none is asked for", () => {
  assert.ok(!appLogFilter("a8ebb").includes("severity"), "severity leaked in unasked");
});

test("a slug with a dash survives intact", () => {
  const f = appLogFilter("cursor-meetup");
  assert.ok(f.includes("cursor-meetup"), "the slug was mangled");
});
