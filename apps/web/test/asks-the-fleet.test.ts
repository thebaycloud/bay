import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Questions the pipeline asks CLOUD RUN about apps that are not on Cloud Run.
 *
 * A third kind of the day's defect, after the delete path dropping on the wrong
 * Postgres instance and a check verifying itself over the same broken
 * connection: a lookup that was correct while every app had a Cloud Run service,
 * and that answers for every app identically now that none does.
 *
 * They are quiet because the answer is well-formed. "No service exists" is a
 * real reply, not an error — so nothing throws, nothing logs, and the caller
 * carries on with a fact that is false for every app it will ever see.
 *
 * Read from source rather than exercised, because both are internal to
 * `runDeploy` and the fact being pinned is WHICH SYSTEM is consulted. Behaviour
 * cannot distinguish "asked the fleet" from "asked Cloud Run and got nothing"
 * — that indistinguishability is the defect.
 */

const pipeline = readFileSync(join(process.cwd(), "lib/deploy-pipeline.ts"), "utf8");

/** The body of a top-level function in the pipeline, by name. */
function bodyOf(name: string): string {
  const start = pipeline.search(new RegExp(`^(async )?function ${name}\\b`, "m"));
  assert.ok(start >= 0, `${name} not found — renamed, or gone`);
  let depth = 0, seen = false;
  for (let i = start; i < pipeline.length; i++) {
    if (pipeline[i] === "{") { depth++; seen = true; }
    else if (pipeline[i] === "}") { depth--; if (seen && depth === 0) return pipeline.slice(start, i + 1); }
  }
  throw new Error(`${name}: unbalanced braces`);
}

test("`cold` is decided by whether this app was ever built, not by a Cloud Run service", () => {
  // It asked `describeServiceRest(slug)`. The fleet places a container on a node
  // and creates no service, so that returned "no service" for every deploy and
  // every fleet deploy was recorded cold. `cold` exists to separate cache hits
  // from misses, and a column that answers the same way for every row separates
  // nothing.
  const body = bodyOf("isFirstDeploy");
  assert.doesNotMatch(body, /describeServiceRest/,
    "a Cloud Run service is not evidence about an app that never had one");
  assert.match(body, /FROM releases WHERE slug/,
    "a prior release is a prior build of this image, which is what a cache could hit");
});

test("the out-of-band env check reads where `env set` actually writes", () => {
  // The check refuses a deploy when an external database's URL variable has been
  // set nowhere. Its third source existed because `supersonic env set` wrote a
  // plain variable on the live Cloud Run service — invisible to this deploy's
  // upload and to Secret Manager both.
  //
  // For a fleet app that command now calls `setPlacementEnv` and writes the
  // PLACEMENT SPEC (see app/api/apps/[slug]/env/route.ts, which branches on
  // `target.kind === "fleet"`). Reading the service returned nothing every time,
  // so a user who set the variable exactly as documented was told nothing had —
  // and the deploy stopped before provisioning or building anything.
  const body = bodyOf("liveEnvNames");
  assert.doesNotMatch(body, /describeServiceRest/,
    "fleet apps have no Cloud Run service to read variables off");
  assert.match(body, /placementEnvKeys/,
    "read the placement spec — the place `env set` writes for a fleet app");
});

test("no null is reported as a fact", () => {
  // "Could not tell" and "this is the first deploy" are different, and recording
  // the second for the first turns a measurement into a guess. Both functions
  // keep that distinction: one returns null on failure, the other treats a
  // missing placement as unknown rather than as "no variables".
  assert.match(bodyOf("isFirstDeploy"), /return null/,
    "a failed lookup must not be recorded as a first deploy");
  assert.match(bodyOf("liveEnvNames"), /\?\?\s*\[\]/,
    "an app with no placement yields nothing to check, not an assertion that it has none");
});
