import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, isPlatformFailure, isSameFailure, errorFingerprint } from "../lib/deploy-errors";

/**
 * The rule being pinned: a failure belongs to the platform when NO edit to the
 * user's repository could fix it. Not "unlikely to be their fault" — impossible.
 * Anything classified as the platform's never reaches the repair agent, which
 * has edit access to the customer's code and, asked to fix something that is not
 * there, invents work.
 */

test("failures no repo edit could fix never reach the repair agent", () => {
  const platform = [
    "IAM_FAILURE for serviceAccount:x: permission denied",
    "AMBIGUOUS_STACK: this repo declares both Python and Node",
    "Runtime not available: this app needs Python >=3.15 and the runner has 3.14",
    "ERROR: (gcloud.run.deploy) User does not have permission to act as service account",
    "Quota exceeded for quota metric 'Build requests'",
    "Error 429: Resource has been exhausted",
    "connect ECONNREFUSED 127.0.0.1:5432",
    "gcloud crashed (BadStatusLine)",
    "500 Internal Server Error from the backend",
  ];
  for (const e of platform) {
    assert.equal(isPlatformFailure(e), true, `should be the platform's: ${e}`);
  }
});

test("failures the repo really can fix are still sent to the agent", () => {
  const app = [
    "Error: Cannot find module './routes'",
    "SyntaxError: Unexpected token '}' in server.js",
    "npm ERR! missing script: build",
    "this site has no `dist` directory to publish.",
    "ModuleNotFoundError: No module named 'flask'",
  ];
  for (const e of app) {
    assert.equal(isPlatformFailure(e), false, `should be the app's: ${e}`);
  }
});

test("a platform failure carries a sentence the user can act on", () => {
  const c = classify("Quota exceeded for quota metric 'Build requests'");
  assert.equal(c.blame, "platform");
  assert.match(c.reason!, /Your code is fine/);
});

test("a deploy that failed while saying nothing is ours, not theirs", () => {
  // Handing an empty error to an agent asks it to guess, and it will.
  const c = classify("");
  assert.equal(c.blame, "platform");
  assert.match(c.reason!, /gap in our reporting/);
});

test("the marker constants are matched exactly, not by pattern", () => {
  assert.equal(classify("IAM_FAILURE: x").reason, "IAM_FAILURE: x");
});

/* ── the loop guard ──────────────────────────────────────────────────────── */

test("the same failure twice is recognised despite ids and timestamps moving", () => {
  // MAX_REDEPLOYS counted attempts and nothing compared errors, so three
  // identical failures cost three full cloud builds.
  const a = "Build 8f2a1c3d-1111-2222-3333-444455556666 failed at 2026-08-01T10:11:12Z: Cannot find module './routes'";
  const b = "Build 91bb77aa-9999-8888-7777-666655554444 failed at 2026-08-01T10:19:44Z: Cannot find module './routes'";
  assert.equal(isSameFailure(a, b), true);
});

test("a genuinely different failure is not mistaken for the same one", () => {
  assert.equal(
    isSameFailure("Cannot find module './routes'", "Cannot find module './db'"),
    false,
  );
});

test("revision suffixes and hex blobs do not make two identical failures look different", () => {
  const a = "Revision demo-00021-abc failed: container failed to start";
  const b = "Revision demo-00022-xyz failed: container failed to start";
  assert.equal(isSameFailure(a, b), true);
});

test("an absent previous failure is never the same as the first one", () => {
  // Otherwise the very first failure would count as a repeat and stop the agent
  // before it had tried anything.
  assert.equal(isSameFailure(undefined, "anything"), false);
  assert.equal(isSameFailure("", "anything"), false);
});

test("the fingerprint is bounded, so a giant build log cannot be the comparison", () => {
  assert.ok(errorFingerprint("x".repeat(50000)).length <= 2000);
});
