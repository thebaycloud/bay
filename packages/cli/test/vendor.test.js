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
 *
 * The list of sources is no longer written down twice. It used to be a literal in
 * stamp.mjs naming seven files, and esbuild inlines more than seven — so a rewrite
 * of an unlisted input (repo-runtime.ts is the one that mattered) moved nothing and
 * this test stayed green on a bundle built from the old rules. It now comes from
 * esbuild's own metafile via vendor/inputs.json, and the first assertion below is
 * that the file is there at all: an empty list makes a stamp loop pass by iterating
 * nothing, which is the same silence in a new place.
 */
const { test } = require("node:test");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const CLI_ROOT = path.join(__dirname, "..");
const REPO_ROOT = path.join(CLI_ROOT, "..", "..");

/** A published tarball has vendor/ but not apps/web — there is nothing to compare against. */
const inCheckout = fs.existsSync(path.join(REPO_ROOT, "apps/web/lib/resolve.ts"));

test("every vendored bundle was built from the source that is here now", { skip: !inCheckout }, async () => {
  const { readInputs, stampSources, stampOf } = await import("../scripts/stamp.mjs");
  const inputs = readInputs(CLI_ROOT);

  // A missing or half-written inputs.json turns the loop below into zero
  // assertions, which reads as a pass. Both bundles have to be described before
  // anything is compared.
  assert.deepEqual(
    Object.keys(inputs).sort(), ["detector.js", "resolve.js"],
    "vendor/inputs.json does not describe both bundles — run `npm run bundle` in packages/cli",
  );

  // Each bundle's own entry point has to be in its list. That is the cheapest
  // proof the metafile was actually read: a list assembled any other way is
  // liable to describe the imports and forget the file doing the importing.
  const ENTRY = {
    "resolve.js": "packages/cli/src/resolver.entry.ts",
    "detector.js": "packages/detector/src/index.ts",
  };

  for (const [file, sources] of Object.entries(inputs)) {
    assert.ok(sources.includes(ENTRY[file]), `vendor/inputs.json for ${file} is missing its entry point ${ENTRY[file]}`);
    const built = stampOf(path.join(CLI_ROOT, "vendor", file));
    assert.equal(
      built, stampSources(REPO_ROOT, sources),
      `vendor/${file} is stale — run \`npm run bundle\` in packages/cli`,
    );
  }
});

test("the stamp covers every file esbuild inlines, not a list somebody maintains", { skip: !inCheckout }, async () => {
  // The regression this closes: stamp.mjs named seven sources for resolve.js and
  // esbuild pulls in fourteen, so a rewrite of any of the other seven moved
  // nothing and this file stayed green on a bundle built from the old rules.
  // repo-runtime.ts is the one that mattered — it is the first file the deploy
  // plan rewrites. Named individually rather than counted, because a count passes
  // the day somebody swaps one file for another.
  const { readInputs } = await import("../scripts/stamp.mjs");
  const listed = new Set(readInputs(CLI_ROOT)["resolve.js"] ?? []);
  //
  // Three of the seven this listed are gone: process-plan.ts, process-deploy.ts
  // and release-job.ts left with the Cloud Run lane on 16 Aug (575549d), and
  // slug.ts is no longer on the resolver's import graph — `grep cloudRunName
  // vendor/resolve.js` finds nothing. Asserting a deleted file is a test that
  // can only be red, and this one was, which took `npm test` with it — and
  // prepublishOnly runs npm test, so no CLI could be published while it stood.
  //
  // The list outliving the files is the failure mode this test's own comment
  // warns about, so it is now checked against the CHECKOUT as well as the
  // stamp: a file that stops existing fails here by name instead of silently
  // asserting nothing.
  for (const rel of [
    "apps/web/lib/repo-runtime.ts",
    "apps/web/lib/procfile.ts",
    "apps/web/lib/processes.ts",
    "apps/web/lib/resolve.ts",
    "apps/web/lib/detect.ts",
    "apps/web/lib/app-config.ts",
  ]) {
    assert.ok(
      existsSync(join(REPO_ROOT, rel)),
      `${rel} is named here but not in the checkout — the list is stale, not the stamp`,
    );
    assert.ok(listed.has(rel), `${rel} is bundled into vendor/resolve.js but not covered by its stamp`);
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
