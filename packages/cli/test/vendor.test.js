"use strict";
/**
 * The bundles are the control plane's source, and this proves it.
 *
 * `supersonic check` is only worth two seconds of anyone's time if it answers the
 * question the server answers. The guarantee is not "these two agree on the
 * fixtures we thought of" — it is that there is one implementation and the CLI
 * carries a compiled copy of it. So the test is a stamp comparison, which is
 * stronger than any behavioural pinning: a single character changed in
 * resolve.ts, app-config.ts, infer-services.ts, repo-facts.ts, lanes.ts or
 * plan-deps.ts fails this until the bundle is rebuilt.
 *
 * Written because the committed vendor/detector.js had been stale for two days
 * and was still answering `python:3.12` after plan-deps.ts moved the platform to
 * 3.14 — the exact number whose wrongness that file's comment is about.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const CLI_ROOT = path.join(__dirname, "..");
const REPO_ROOT = path.join(CLI_ROOT, "..", "..");

/** A published tarball has vendor/ but not apps/web — there is nothing to compare against. */
const inCheckout = fs.existsSync(path.join(REPO_ROOT, "apps/web/lib/resolve.ts"));

test("every vendored bundle was built from the source that is here now", { skip: !inCheckout }, async () => {
  const { BUNDLES, stampSources, stampOf } = await import("../scripts/stamp.mjs");
  for (const [file, sources] of Object.entries(BUNDLES)) {
    const built = stampOf(path.join(CLI_ROOT, "vendor", file));
    assert.equal(
      built, stampSources(REPO_ROOT, sources),
      `vendor/${file} is stale — run \`npm run bundle\` in packages/cli`,
    );
  }
});

test("the resolver bundle exposes the whole resolution path, not a subset of it", () => {
  const r = require("../vendor/resolve.js");
  // Every name `init` and `check` reach for. A bundle missing one of these fails
  // at the moment a user runs the command, which is the worst place to find out.
  for (const name of [
    "resolve", "validate", "assertConsumed", "deriveLane", "missingSecrets",
    "readAppConfig", "parseAppConfig", "platformOwned",
    "inferAppConfig", "deployableParts", "serviceFor", "readRepoFacts",
    "runtimeMismatch",
  ]) {
    assert.equal(typeof r[name], "function", `missing export: ${name}`);
  }
  assert.equal(r.CONFIG_FILENAME, "supersonic.json");
  assert.equal(typeof r.RUNTIME_VERSIONS.python, "string");
  assert.equal(typeof r.DEFAULT_SCALE.memory, "string");
});

test("the detector bundle reports the Python the runner actually has", () => {
  // The regression, named: a hand-written `python:3.12` in the detector against a
  // runner shipping 3.14 built every `requires-python >= 3.14` repo on the wrong
  // interpreter and failed at pip, blaming the app.
  const { RUNTIME_VERSIONS } = require("../vendor/resolve.js");
  const { detectStack } = require("../vendor/detector.js");
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "cli-vendor-"));
  fs.writeFileSync(path.join(dir, "requirements.txt"), "fastapi\n");
  assert.equal(detectStack(dir).runtime, `python:${RUNTIME_VERSIONS.python}`);
});
