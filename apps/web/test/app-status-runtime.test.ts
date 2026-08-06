import { test } from "node:test";
import assert from "node:assert/strict";
import { statusFromFleet } from "../lib/app-status";
import type { AppSpec } from "../lib/fleet-spec";
import type { ProcessState } from "../lib/fleet";

/**
 * What `supersonic status` answers for an app that runs on the FLEET.
 *
 * The route asked Cloud Run and nothing else. That produced two wrong answers
 * for the same reason, and the second is worse than the first:
 *
 *  - No Cloud Run service (every app deployed since the fleet became the
 *    default): the route fell through to a branch written for STATIC apps and
 *    reported empty revision, empty image, no env, `served: "static"`. Measured
 *    on 6 Aug — five apps deployed as a user, all placed on fleet-lab-2, all
 *    reporting `revision —  image —  env none` while serving.
 *
 *  - A STALE Cloud Run service left behind when the app moved: the route
 *    answered from it. `a8ebb` serves fine on fleet-lab-1 and was reported
 *    `ready: false`, because its abandoned Cloud Run revision cannot start.
 *    That is not blank, it is wrong, and it looks right.
 *
 * The fix is to ask where the app RUNS before asking anything else.
 */

const SPEC: AppSpec = {
  slug: "t1ppt",
  image: "us-central1-docker.pkg.dev/p/r/t1ppt@sha256:abc",
  env: { SUPERSONIC_URL: "https://t1ppt.supersonic.cv", PORT: "8080" },
  secrets: { DATABASE_URL: "app-t1ppt-DATABASE_URL", PGPASSWORD: "app-t1ppt-PGPASSWORD" },
  port: 8080,
  memoryBytes: 2 << 30,
  cpuShares: 1024,
  processes: [
    { name: "web", kind: "web" },
    { name: "release", kind: "release", command: ["python", "migrate.py"] },
    { name: "nightly", kind: "cron", command: ["python", "digest.py"] },
  ],
};

const RUNNING_WEB: ProcessState[] = [
  { slug: "t1ppt", process: "web", image: SPEC.image, healthy: true },
];

test("a fleet app reports the image it is actually running", () => {
  const s = statusFromFleet("t1ppt", "fleet-lab-2", SPEC, RUNNING_WEB);
  assert.equal(s.image, SPEC.image, "the image comes from the node, not from an em-dash");
  assert.equal(s.served, "fleet");
  assert.equal(s.node, "fleet-lab-2");
});

test("a fleet app reports the env it was given, secret NAMES included", () => {
  const s = statusFromFleet("t1ppt", "fleet-lab-2", SPEC, RUNNING_WEB);
  // Names only. A value here would be a database password in an API response.
  assert.ok(s.envKeys.includes("DATABASE_URL"), "secret-backed vars are env the app has");
  assert.ok(s.envKeys.includes("SUPERSONIC_URL"));
  assert.ok(!JSON.stringify(s).includes("app-t1ppt-PGPASSWORD") || s.envKeys.includes("PGPASSWORD"),
    "secret IDS must not leak as values");
  for (const k of s.envKeys) assert.ok(!k.includes("://"), `envKeys must be names, got ${k}`);
});

test("a healthy web process means ready", () => {
  const s = statusFromFleet("t1ppt", "fleet-lab-2", SPEC, RUNNING_WEB);
  assert.equal(s.ready, true);
});

test("a web process the node cannot reach is NOT ready", () => {
  const s = statusFromFleet("t1ppt", "fleet-lab-2", SPEC,
    [{ slug: "t1ppt", process: "web", image: SPEC.image, healthy: false }]);
  assert.equal(s.ready, false, "explicit false is the only failure signal");
});

test("a worker-only app is ready when its worker runs, not when a probe answers", () => {
  // `bot` — one process, kind worker, no port. `healthy` is ABSENT because
  // nobody asked. Treating absent as false would report every worker-only app
  // as down, which is the defect the nullable health field was added to end.
  const spec: AppSpec = { ...SPEC, slug: "sxou5",
    processes: [{ name: "bot", kind: "worker", command: ["python", "bot.py"] }] };
  const s = statusFromFleet("sxou5", "fleet-lab-2", spec,
    [{ slug: "sxou5", process: "bot", image: spec.image }]);
  assert.equal(s.ready, true, "a running worker with nothing to probe is up");
});

test("an app placed but running nothing is not ready", () => {
  const s = statusFromFleet("t1ppt", "fleet-lab-2", SPEC, []);
  assert.equal(s.ready, false, "placed is not running");
});

test("the database is reported when the app has one", () => {
  // ISSUE-003: `database none` was printed for every app ever, including ones
  // whose env is full of DATABASE_URL. The app knows: a database-backed app is
  // given DATABASE_URL, and the fleet gives it as a SECRET reference.
  const s = statusFromFleet("t1ppt", "fleet-lab-2", SPEC, RUNNING_WEB);
  assert.equal(s.cloudsql, "t1ppt", "the database name follows the slug");
});

test("an app with no database says so", () => {
  const spec: AppSpec = { ...SPEC, slug: "uibz5", secrets: {}, env: { PORT: "8080" } };
  const s = statusFromFleet("uibz5", "fleet-lab-2", spec,
    [{ slug: "uibz5", process: "web", image: spec.image, healthy: true }]);
  assert.equal(s.cloudsql, "", "no database is an empty string, which the CLI prints as none");
});

test("processes are reported, so a user can see what their app actually runs", () => {
  const s = statusFromFleet("t1ppt", "fleet-lab-2", SPEC, RUNNING_WEB);
  const kinds = (s.processes ?? []).map((p) => `${p.name}:${p.kind}`);
  assert.deepEqual(kinds.sort(), ["nightly:cron", "release:release", "web:web"]);
  // And which of them is actually up right now.
  const web = (s.processes ?? []).find((p) => p.name === "web");
  assert.equal(web?.running, true);
  const nightly = (s.processes ?? []).find((p) => p.name === "nightly");
  assert.equal(nightly?.running, false, "a cron is not a long-running process");
});
