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

test("a builder that lacks the pinned runtime is explained, not called unfixable", () => {
  // What production said when a real app pinned `.python-version: 3.12` and the
  // builder only carried 3.13 and 3.14:
  //
  //   Google Cloud returned an internal error. Nothing in your repository caused
  //   it and nothing there can fix it.
  //
  // Every clause of that was wrong. It is not internal, not Google's fault, and
  // the repository is exactly where it can be fixed — the builder had already
  // printed the reason and the full list of versions it has. Telling someone
  // their problem is unfixable while holding the answer is the worst thing an
  // error can do.
  const real = `Step #1: [builder] Using Python version from /workspace/.python-version: 3.12
Step #1: [builder] failed to build: (error ID: 7c5435e0):
Step #1: [builder] invalid Python version specified: failed to resolve version matching: 3.12 against [3.14.6 3.14.5 3.13.14 3.13.0]
gcloud exited 1`;

  const c = classify(real);
  assert.equal(c.blame, "platform", "this must never reach the repair agent");
  assert.match(c.reason!, /pins runtime 3\.12/);
  assert.match(c.reason!, /builder only has 3\.14, 3\.13/);
  assert.match(c.reason!, /Nothing is wrong with your code/);
  // And it says why stopping was the right outcome, so the pin does not read as
  // the thing that broke the deploy.
  assert.match(c.reason!, /the pin is being honoured/);

  assert.doesNotMatch(c.reason!, /internal error/);
  assert.doesNotMatch(c.reason!, /nothing there can fix it/);
});

test("an app error inside a build log is not the platform's fault", () => {
  // The failure this closes was silent and total. Build failures arrive as a
  // one-line verdict plus up to forty log lines, and those lines are SELECTED for
  // containing words like "denied", "not found" and "invalid" — so the blob is a
  // worst case for a substring classifier: forty lines chosen for looking
  // alarming. One `EACCES: permission denied` from npm made the whole deploy
  // "platform", which returns before the repair agent ever sees it.
  //
  // And it was invisible: attempts.ts records `repair: "none"`, which is
  // indistinguishable from a deploy that never needed one.
  const npmEacces = [
    "Build failed:",
    "npm error code EACCES",
    "npm error syscall mkdir",
    "npm error Error: EACCES: permission denied, mkdir '/root/.npm'",
    "npm error [Error: EACCES: permission denied, mkdir '/root/.npm'] {",
  ].join("\n");
  assert.equal(classify(npmEacces).blame, "app");

  // Same for the other alarming words the log filter deliberately keeps.
  for (const line of ["module not found: ./config", "403 Forbidden from the npm registry", "quota exceeded in your test fixture"]) {
    assert.equal(classify(`Build failed:\n${line}`).blame, "app", line);
  }
});

test("a real platform failure is still caught, because the verdict says so", () => {
  // Scoping to the verdict must not blind it: when the platform genuinely fails,
  // that IS the one-line summary rather than something quoted from a build.
  assert.equal(classify("Permission denied granting the build access to the secret").blame, "platform");
  assert.equal(classify("gcloud: quota exceeded").blame, "platform");
  // …and our own markers match anywhere, because those are strings we throw.
  assert.equal(classify("Build failed:\nRuntime not available: something").blame, "platform");
});

test("a registry that will not name the image it was just given is ours", () => {
  // The failure the digest pin introduced, and the reason it is classified at
  // all: it happens AFTER a successful build and push, so every word in it is
  // about our registry and none of it is about the repository. Handed to the
  // repair agent it buys a $12-15 read of a customer's app that finds nothing —
  // and the ledger already records that we decided not to fuse the agent off.
  const c = classify("the image digest could not be resolved: the build pushed us-central1-docker.pkg.dev/p/r/demo:latest, and the registry did not say which image that now names.");
  assert.equal(c.blame, "platform");
});

test("pip disagreeing with the interpreter is the app's problem now", () => {
  // It was the platform's while the platform held one Python. `FROM python:3.14`
  // is buildable, so "requires a different Python" in a build log is an ordinary
  // dependency conflict — usually one line of a manifest — and the repair agent
  // fixes those. Blaming the platform hid a fixable error from the only thing
  // that fixes it.
  assert.equal(classify("Build failed:\nERROR: Package 'x' requires a different Python: 3.12.13 not in '>=3.14'").blame, "app");
  // Our own refusal is still ours.
  assert.equal(classify("Runtime not available: the builder has no 3.15").blame, "platform");
});
