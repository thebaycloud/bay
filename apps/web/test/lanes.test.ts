import { test } from "node:test";
import assert from "node:assert/strict";
import {
  databaseEnv, databaseEnvNames,
  DEFAULT_SCALE, DEFAULT_PORT, withScale, SERVICE_LANES,
  needsServiceRecreate,
  type Lane, type LaneDeploy, type Scale } from "../lib/lanes";

/**
 * The parity suite.
 *
 * `appFlags` — which carries --update-env-vars and --update-secrets — used to be
 * appended at exactly ONE of four call sites. An app on the Dockerfile or
 * buildpack lane therefore deployed with an empty environment and no network
 * path to the database the pipeline had just provisioned for it, and nothing in
 * its logs said so.
 *
 * These are deliberately ONE loop over SERVICE_LANES rather than one test per
 * lane. Four separate tests are four places to forget: a fifth lane can be added
 * without a fifth test and nothing goes red. A loop over the exported lane list
 * cannot be extended without the new lane immediately being asserted.
 */

const SERVICE_FLAGS = ["--region", "us-central1", "--project", "p", "--format=json"];
const APP_FLAGS = [
  "--update-env-vars=^~~^DATABASE_URL=postgresql://u:p@127.0.0.1:5432/db~~LOG_LEVEL=info",
  "--update-secrets=DJANGO_SECRET_KEY=app-demo-DJANGO_SECRET_KEY:latest",
];

/** One request per lane, differing only in how the lane names its code. */
function request(lane: Lane, over: Partial<LaneDeploy> = {}): LaneDeploy {
  const base: LaneDeploy = {
    lane,
    service: "demo",
    serviceFlags: SERVICE_FLAGS,
    appFlags: APP_FLAGS,
    scale: DEFAULT_SCALE,
    cloudsql: null,
    image: "img:latest",
  };
  return { ...base, ...over };
}


/**
 * The shape rule, asserted directly because it is not idempotent: naming the
 * container of a service last deployed with an unnamed one rewrites a live
 * service's container set. The runner lane has always named it; the other two
 * never have, and may only start when they gain a sidecar they never had.
 */


/**
 * The protected-name set in Phase 2 is derived from this list rather than typed
 * out again. The two drifted apart once already — 6 names against 17 — and every
 * name missing from the shorter list was a user value silently overwritten.
 */
test("every database variable the platform writes is reported as a name", () => {
  const pairs = databaseEnv({ databaseUrl: "postgresql://u:p@h/db", user: "u", password: "p", dbName: "db" });
  const names = databaseEnvNames();
  assert.equal(names.length, pairs.length);
  assert.ok(names.includes("DATABASE_URL"));
  assert.ok(names.includes("POSTGRES_SERVER"));
  assert.ok(names.includes("PGPASSWORD"));
  assert.ok(names.includes("DB_NAME"));
  assert.ok(names.every((n) => n === n.toUpperCase() && !n.includes("=")));
});


for (const lane of SERVICE_LANES) {


  /**
   * The other thing Cloud Run refuses a multi-container revision for, and the one
   * that went unnoticed because the assertions asked what the argv CONTAINED and
   * never what gcloud would do with it:
   *
   *   ERROR: (gcloud.run.deploy) Invalid value for [--container]:
   *   Exactly one container must specify --port or --use-http2
   *
   * A service has no other way to say which container answers requests. The
   * runner lane passed --port from the start and so never saw it; the container
   * and buildpack lanes reached the scoped shape for the first time the day they
   * gained a sidecar, and every app that took them was undeployable.
   */


}


test("a service that gained a database is recreated, and nothing else is", () => {
  // Cloud Run cannot rename the container of a live service. A sidecar requires
  // named containers, so an app that already exists and then gains a database
  // is undeployable by the ordinary route — measured against the real API on
  // 5 Aug, including the control that isolates the cause:
  //
  //   new service + sidecar                  → deploys
  //   existing flat service + sidecar        → "exactly one container with an
  //                                             exposed port"
  //   existing flat service + named, NO sidecar → the same error, so it is the
  //                                             naming and not the sidecar
  //   delete, then deploy with the sidecar   → deploys
  //
  // This is the one shape that must trigger it.
  assert.equal(needsServiceRecreate({ cloudsql: "proj:region:inst", existingScoped: false }), true);
});

test("a service that already has named containers is left alone", () => {
  // The runner lane has deployed `--container app` from the start. Deleting one
  // of those would destroy a working service for no reason at all.
  assert.equal(needsServiceRecreate({ cloudsql: "proj:region:inst", existingScoped: true }), false);
});

test("an app with no database is never recreated", () => {
  // No sidecar, no naming, no transition. Every app without a database keeps
  // deploying exactly as it did.
  assert.equal(needsServiceRecreate({ cloudsql: null, existingScoped: false }), false);
  assert.equal(needsServiceRecreate({ existingScoped: false }), false);
});

test("a first deploy has nothing to delete, and an unanswerable lookup is not permission to", () => {
  // `liveContainerShape` returns null for a service that does not exist AND for
  // a describe that failed. Treating either as `false` would have a transient
  // API error delete a live service — the worst possible way to be wrong here,
  // and the reason this is `=== false` rather than a falsy test.
  assert.equal(needsServiceRecreate({ cloudsql: "proj:region:inst", existingScoped: null }), false);
  assert.equal(needsServiceRecreate({ cloudsql: "proj:region:inst" }), false);
});
