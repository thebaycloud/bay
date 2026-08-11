import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileHealth, type PassRecord } from "@/lib/reconcile";

const NOW = 1_000_000_000_000;
const rec = (o: Partial<PassRecord> = {}): PassRecord =>
  ({ lastAttemptAt: NOW - 30_000, lastSuccessAt: NOW - 30_000, consecutiveFailures: 0, lastError: null, ...o });

// The failure this exists for. The reconciler errored on every pass for forty
// minutes and nothing noticed, because a loop that throws and a loop with
// nothing to do both answer "no steps" — the same absent-versus-empty confusion
// this codebase refuses to make on the wire, made by the loop about itself.
test("a loop that has not succeeded for longer than its own period is not healthy", () => {
  const h = reconcileHealth(rec({ lastSuccessAt: NOW - 600_000, consecutiveFailures: 9 }), NOW);
  assert.equal(h.healthy, false);
  assert.match(h.reason ?? "", /has not completed a pass/);
});

test("a loop that just succeeded is healthy and says nothing", () => {
  const h = reconcileHealth(rec(), NOW);
  assert.equal(h.healthy, true);
  assert.equal(h.reason, undefined);
});

// Not the same as failing. A scheduler that stopped calling, a job that was
// disabled, a deploy that removed the trigger — all leave the last pass looking
// perfectly successful and simply old, and "it worked when it last ran" is not
// an answer to "is it running".
test("a loop that stopped being called at all is not healthy either", () => {
  const h = reconcileHealth(rec({ lastAttemptAt: NOW - 600_000, lastSuccessAt: NOW - 600_000 }), NOW);
  assert.equal(h.healthy, false);
  assert.match(h.reason ?? "", /has not been called/);
});

// A pass that has never run is a fresh install, not a fault. Reporting the
// absence of history as a failure would make every new environment look broken.
test("a loop that has never run is not reported as broken", () => {
  const h = reconcileHealth(null, NOW);
  assert.equal(h.healthy, true);
  assert.match(h.reason ?? "", /never run/);
});

// One failure is a bad minute. The loop retries every minute by design, and
// alarming on a single one would make the signal useless within a week.
test("a single failure between successes is not a fault", () => {
  const h = reconcileHealth(rec({ consecutiveFailures: 1, lastError: "ECONNRESET" }), NOW);
  assert.equal(h.healthy, true);
});
