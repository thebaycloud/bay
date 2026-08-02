import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deployArgs, dbContainerArgs, databaseEnv, databaseEnvNames,
  DEFAULT_SCALE, DEFAULT_PORT, withScale, SERVICE_LANES,
  type Lane, type LaneDeploy, type Scale,
} from "../lib/lanes";

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
    ...(lane === "buildpack" ? { source: "/tmp/src" } : { image: "img:latest" }),
    ...(lane === "runner" ? { port: 8080 } : {}),
  };
  return { ...base, ...over };
}

for (const lane of SERVICE_LANES) {
  test(`${lane} lane carries the app environment and secrets`, () => {
    const argv = deployArgs(request(lane));
    for (const flag of APP_FLAGS) {
      assert.ok(argv.includes(flag), `${lane} dropped ${flag.split("=")[0]}`);
    }
  });

  test(`${lane} lane sets its own resource envelope`, () => {
    const argv = deployArgs(request(lane));
    // Not Cloud Run's 512 MiB default, which OOM-kills a real Node app at 564
    // MiB before it binds $PORT and reports it as "didn't start on $PORT".
    assert.ok(argv.includes("--memory"), `${lane} left memory at the Cloud Run default`);
    assert.equal(argv[argv.indexOf("--memory") + 1], DEFAULT_SCALE.memory);
    assert.ok(argv.includes(`--max-instances=${DEFAULT_SCALE.maxInstances}`), `${lane} scales unbounded`);
    assert.ok(argv.includes(`--timeout=${DEFAULT_SCALE.timeout}`), `${lane} keeps the 300s default`);
    assert.ok(argv.includes(`--concurrency=${DEFAULT_SCALE.concurrency}`));
    assert.ok(argv.includes("--cpu-boost"));
  });

  test(`${lane} lane attaches the Cloud SQL proxy when the app has a database`, () => {
    const argv = deployArgs(request(lane, { cloudsql: "proj:region:inst" }));
    assert.ok(argv.includes("--depends-on"), `${lane} deployed a database app with no proxy`);
    assert.equal(argv[argv.indexOf("--depends-on") + 1], "cloudsql-proxy");
    for (const flag of dbContainerArgs("proj:region:inst")) assert.ok(argv.includes(flag));
    // With a sidecar the app's own flags must be scoped to a NAMED container, or
    // gcloud attributes them to whichever container it saw last — which would
    // hand the app's secrets to the proxy.
    const appAt = argv.indexOf("--container");
    assert.equal(argv[appAt + 1], "app");
    assert.ok(appAt < argv.indexOf(APP_FLAGS[0]), `${lane} put app flags before --container app`);
  });

  test(`${lane} lane keeps service-level flags ahead of any --container`, () => {
    const argv = deployArgs(request(lane, { cloudsql: "proj:region:inst" }));
    const first = argv.indexOf("--container");
    for (const flag of [...SERVICE_FLAGS, `--timeout=${DEFAULT_SCALE.timeout}`]) {
      assert.ok(argv.indexOf(flag) < first, `${flag} must precede --container (gcloud rejects it otherwise)`);
    }
  });

  test(`${lane} lane deploys the service under its own name`, () => {
    const argv = deployArgs(request(lane, { service: "other-app" }));
    assert.deepEqual(argv.slice(0, 3), ["run", "deploy", "other-app"]);
  });
}

/**
 * The shape rule, asserted directly because it is not idempotent: naming the
 * container of a service last deployed with an unnamed one rewrites a live
 * service's container set. The runner lane has always named it; the other two
 * never have, and may only start when they gain a sidecar they never had.
 */
test("runner stays container-scoped without a database; the others stay flat", () => {
  assert.ok(deployArgs(request("runner")).includes("--container"));
  assert.ok(!deployArgs(request("container")).includes("--container"));
  assert.ok(!deployArgs(request("buildpack")).includes("--container"));
});

test("a partly-declared scale keeps every default it did not mention", () => {
  // parseAppConfig calls num() on every field, so a config naming only `memory`
  // produces `{memory: "1Gi", cpu: undefined, concurrency: undefined, …}`.
  // Spreading that over the defaults overwrote them with undefined and reached
  // gcloud verbatim: "argument --concurrency: Bad value [undefined]".
  const partial = withScale({
    memory: "1Gi", cpu: 1, maxInstances: 4, timeout: 300,
    concurrency: undefined, cpuBoost: undefined,
  } as Partial<Scale>);
  assert.equal(partial.memory, "1Gi");
  assert.equal(partial.timeout, 300);
  assert.equal(partial.concurrency, DEFAULT_SCALE.concurrency, "an undeclared field keeps its default");
  assert.equal(partial.cpuBoost, DEFAULT_SCALE.cpuBoost);
  // And every value that reaches the argv is a value gcloud will accept.
  for (const [k, v] of Object.entries(partial)) {
    assert.notEqual(v, undefined, `${k} must never reach the argv undefined`);
  }
});

test("an empty or absent scale is exactly the defaults", () => {
  assert.deepEqual(withScale(), DEFAULT_SCALE);
  assert.deepEqual(withScale(null), DEFAULT_SCALE);
  assert.deepEqual(withScale({}), DEFAULT_SCALE);
});

/**
 * The shape belongs to the SERVICE, not to the lane deploying to it.
 *
 * Found by a real deploy, after a nine-minute build and a successful release job:
 * hl52l was created by the buildpack lane with one unnamed container, gained a
 * `supersonic.json` saying `language: "python"`, and moved to the runner lane —
 * which always names its container. gcloud added `app` BESIDE the unnamed one
 * rather than renaming it, and Cloud Run refused the revision with "should
 * contain exactly one container with an exposed port".
 */
test("a service that already has an unnamed container keeps the flat shape", () => {
  const argv = deployArgs(request("runner", { existingScoped: false }));
  assert.ok(!argv.includes("--container"), "the runner lane must not name a container the live service left unnamed");
  assert.ok(argv.includes("--port"), "the port survives — it is what the live container already exposes");
});

test("a service that already has named containers keeps the scoped shape", () => {
  for (const lane of SERVICE_LANES) {
    assert.ok(
      deployArgs(request(lane, { existingScoped: true })).includes("--container"),
      `${lane}: un-naming a live service's container rewrites its container set`,
    );
  }
});

test("a service that does not exist yet takes the lane's own default", () => {
  assert.ok(deployArgs(request("runner", { existingScoped: null })).includes("--container"));
  assert.ok(!deployArgs(request("buildpack", { existingScoped: null })).includes("--container"));
});

test("a sidecar forces the scoped shape whatever the live service looks like", () => {
  // Not a free choice: Cloud Run requires it once more than one container exists,
  // so an app gaining a database has to migrate however it looked before.
  const argv = deployArgs(request("buildpack", { existingScoped: false, cloudsql: "p:r:i" }));
  assert.ok(argv.includes("--container"));
  assert.ok(argv.includes("--depends-on"));
});

test("a lane names its code the way that lane builds", () => {
  assert.ok(deployArgs(request("buildpack")).includes("--source"));
  assert.ok(!deployArgs(request("buildpack")).includes("--image"));
  assert.ok(deployArgs(request("container")).includes("--image"));
  assert.ok(!deployArgs(request("container")).includes("--source"));
});

test("lane-specific container flags survive to the argv", () => {
  // The buildpack retry after gcloud asks for --clear-base-image. Appended to
  // the CONTAINER, not the service: it describes how this code is built.
  const argv = deployArgs(request("buildpack", { containerFlags: ["--clear-base-image"] }));
  assert.ok(argv.includes("--clear-base-image"));
});

test("the static lane deploys no service at all", () => {
  assert.throws(() => deployArgs(request("static" as Lane)), /publishes to GCS/);
});

test("a lane with neither an image nor a source is refused, naming the lane", () => {
  assert.throws(
    () => deployArgs({ ...request("container"), image: undefined }),
    /lane "container" needs an image or a source/,
  );
});

test("a declared scale overrides the defaults and leaves the rest alone", () => {
  const scale = withScale({ memory: "4Gi", timeout: 3600 });
  const argv = deployArgs(request("container", { scale }));
  assert.equal(argv[argv.indexOf("--memory") + 1], "4Gi");
  assert.ok(argv.includes("--timeout=3600"));
  assert.ok(argv.includes(`--concurrency=${DEFAULT_SCALE.concurrency}`));
});

test("cpu-boost is expressed either way, never omitted", () => {
  assert.ok(deployArgs(request("container", { scale: withScale({ cpuBoost: false }) })).includes("--no-cpu-boost"));
});

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

test("the proxy args stay one token, because a value starting with a dash reads as a flag", () => {
  const args = dbContainerArgs("proj:region:inst");
  const arg = args.find((a) => a.startsWith("--args="));
  assert.ok(arg, "the proxy must receive its --args");
  assert.ok(arg!.includes("--port=5432"), "passed as two tokens gcloud refuses with 'expected one argument'");
  assert.ok(arg!.endsWith("proj:region:inst"));
});

test("the proxy carries a startup probe, without which Cloud Run refuses the revision", () => {
  // "Dependent container 'cloudsql-proxy' must have startup probe specified" —
  // so every --depends-on that lacked one was a revision that never existed.
  const args = dbContainerArgs("proj:region:inst");
  const probe = args.find((a) => a.startsWith("--startup-probe="));
  assert.ok(probe, "a --depends-on target without a startup probe is rejected outright");
  // NOT a TCP probe on 5432: the proxy binds that to loopback and the prober
  // connects to the container address, so it fails 30 times against a proxy that
  // is running perfectly.
  assert.match(probe!, /httpGet\.path=\/startup/);
  assert.ok(!probe!.includes("tcpSocket"));
  assert.ok(args.some((a) => a.includes("--health-check")), "the health server has to be switched on");
  assert.ok(args.some((a) => a.includes("--http-address=0.0.0.0")), "the prober cannot reach a loopback-only health port");
  assert.ok(args.every((a) => !a.includes("--address=0.0.0.0")), "the DATABASE port must stay on loopback");
});

for (const lane of SERVICE_LANES) {
  test(`${lane} lane's proxy is probed, so --depends-on is a promise it can keep`, () => {
    const argv = deployArgs(request(lane, { cloudsql: "proj:region:inst" }));
    assert.ok(argv.some((a) => a.startsWith("--startup-probe=")), `${lane} would be rejected by Cloud Run`);
  });

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
  test(`${lane} lane names exactly one ingress port once a sidecar is beside it`, () => {
    const argv = deployArgs(request(lane, { cloudsql: "proj:region:inst" }));
    assert.equal(argv.filter((a) => a === "--port").length, 1, `${lane} would be rejected: exactly one container must specify --port`);
    // On the app's container, not the proxy's — the port marks which one serves.
    assert.ok(argv.indexOf("--port") > argv.indexOf("--container"));
    assert.ok(argv.indexOf("--port") < argv.lastIndexOf("--container"));
  });

  test(`${lane} lane's port does not move when the sidecar arrives`, () => {
    // The sidecar is a database connection, not a change of address. An app that
    // came up on Cloud Run's default 8080 without a database has to come up on
    // 8080 with one.
    const withDb = deployArgs(request(lane, { cloudsql: "proj:region:inst" }));
    const flat = deployArgs(request(lane));
    const portOf = (argv: string[]) => (argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : String(DEFAULT_PORT));
    assert.equal(portOf(withDb), portOf(flat), `${lane} moves the app's port when it gains a database`);
  });
}

test("the probe's timeout is shorter than its period, which Cloud Run enforces", () => {
  // `startup_probe.timeout_seconds: must be less than period_seconds` — rejected
  // outright, not clamped, so the arithmetic is part of the contract.
  const probe = dbContainerArgs("proj:region:inst").find((a) => a.startsWith("--startup-probe="))!;
  const n = (k: string) => Number(probe.match(new RegExp(`${k}=(\\d+)`))![1]);
  assert.ok(n("timeoutSeconds") < n("periodSeconds"), `${probe} would be refused`);
  // And enough total time for the proxy to authorise against Cloud SQL.
  assert.ok(n("periodSeconds") * n("failureThreshold") >= 60);
});
