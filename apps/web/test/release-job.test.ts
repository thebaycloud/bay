import { test } from "node:test";
import assert from "node:assert/strict";
import {
  releaseJobArgs, releaseExecuteArgs, releaseLogsArgs, releaseJobName, proxyWait,
  RELEASE_CONTAINER, RELEASE_TIMEOUT, releaseFromPlan, type ReleaseJob,
} from "../lib/release-job";
import { dbContainerArgs, DEFAULT_SCALE, withScale, SERVICE_LANES, type Lane } from "../lib/lanes";

/**
 * The release phase, asserted the same way lane parity is: one loop over the
 * exported lane list, so a lane cannot be added without its release appearing
 * here. Every service lane can declare `release` (LANE_CONSUMES in resolve.ts
 * says so for all three), and a release that quietly carried no database
 * credentials would be the Phase 0 bug again with a new name.
 */

const ENV = [
  "DATABASE_URL=postgresql://u:p@127.0.0.1:5432/db",
  "STORAGE_BUCKET=supersonicdeploy-demo",
  "SUPERSONIC_CODE_BUCKET=assets",
  "SUPERSONIC_CODE_OBJECT=ready/demo/r1.tgz",
  "SUPERSONIC_RUN=gunicorn config.wsgi --bind 0.0.0.0:$PORT",
];
const SECRETS = "DJANGO_SECRET_KEY=app-demo-DJANGO_SECRET_KEY:latest";
const RELEASE = "(cd backend && python manage.py migrate --noinput)";
const CONN = "proj:region:inst";

function job(lane: Lane, over: Partial<ReleaseJob> = {}): ReleaseJob {
  return {
    lane,
    service: "demo",
    region: "us-central1",
    project: "p",
    serviceAccount: "apps@p.iam.gserviceaccount.com",
    labels: ["supersonic-name=demo"],
    release: RELEASE,
    env: ENV,
    secrets: SECRETS,
    scale: DEFAULT_SCALE,
    cloudsql: CONN,
    ...(lane === "buildpack" ? { source: "/tmp/src" } : { image: "img:latest" }),
    ...over,
  };
}

for (const lane of SERVICE_LANES) {
  test(`${lane} release carries the app environment`, () => {
    const argv = releaseJobArgs(job(lane));
    const envFlag = argv.find((a) => a.startsWith("--update-env-vars="));
    assert.ok(envFlag, `${lane} released with an empty environment`);
    for (const pair of ENV) {
      if (pair.startsWith("SUPERSONIC_RUN=")) continue;
      assert.ok(envFlag!.includes(pair), `${lane} dropped ${pair.split("=")[0]}`);
    }
    // One flag, not two: a second --update-env-vars replaces the first rather
    // than merging with it, so the app's whole environment would vanish.
    assert.equal(argv.filter((a) => a.startsWith("--update-env-vars=")).length, 1);
  });

  test(`${lane} release mounts the same secrets as the revision`, () => {
    const argv = releaseJobArgs(job(lane));
    assert.ok(argv.includes(`--update-secrets=${SECRETS}`), `${lane} released without its secrets`);
  });

  test(`${lane} release runs beside the Cloud SQL proxy`, () => {
    const argv = releaseJobArgs(job(lane));
    // The whole reason this is a job and not a Cloud Build step: the build has
    // nothing listening on 127.0.0.1:5432, so `manage.py migrate` hangs there
    // until the 1200s timeout.
    assert.ok(argv.includes("--depends-on"), `${lane} released with no proxy — the migration cannot reach the database`);
    assert.equal(argv[argv.indexOf("--depends-on") + 1], "cloudsql-proxy");
    for (const flag of dbContainerArgs(CONN)) assert.ok(argv.includes(flag));
  });

  test(`${lane} release scopes the app's flags to its own container`, () => {
    const argv = releaseJobArgs(job(lane));
    const at = argv.indexOf("--container");
    assert.equal(argv[at + 1], RELEASE_CONTAINER);
    // Everything the app's container owns must follow it, or gcloud attributes
    // it to whichever container it saw last — which hands the app's secrets to
    // the proxy.
    for (const flag of argv.filter((a) => a.startsWith("--update-env-vars=") || a.startsWith("--update-secrets="))) {
      assert.ok(argv.indexOf(flag) > at, `${flag.split("=")[0]} must follow --container ${RELEASE_CONTAINER}`);
    }
    // Service-level flags may not appear after the first --container.
    for (const flag of ["--region", "--project", "--max-retries=0"]) {
      assert.ok(argv.indexOf(flag) < at, `${flag} must precede --container (gcloud rejects it otherwise)`);
    }
  });

  test(`${lane} release runs exactly once and is never retried`, () => {
    const argv = releaseJobArgs(job(lane));
    // The three flags that make this a RELEASE rather than another way to run
    // the migration N times: one task, no parallelism, no retry of a migration
    // that failed half way against the schema it just half-changed.
    assert.ok(argv.includes("--tasks=1"));
    assert.ok(argv.includes("--parallelism=1"));
    assert.ok(argv.includes("--max-retries=0"));
  });

  test(`${lane} release gets a deadline a migration can finish inside`, () => {
    const argv = releaseJobArgs(job(lane));
    // Cloud Run's job default is 600s, and being killed at 600s leaves a
    // half-applied schema behind a release reported as failed.
    assert.ok(argv.includes(`--task-timeout=${RELEASE_TIMEOUT}s`));
    assert.ok(RELEASE_TIMEOUT > 600);
    assert.ok(releaseJobArgs(job(lane, { taskTimeout: 3600 })).includes("--task-timeout=3600s"));
  });

  test(`${lane} release gets the app's resource envelope, not Cloud Run's default`, () => {
    const argv = releaseJobArgs(job(lane, { scale: withScale({ memory: "4Gi", cpu: 2 }) }));
    assert.equal(argv[argv.indexOf("--memory") + 1], "4Gi");
    assert.equal(argv[argv.indexOf("--cpu") + 1], "2");
  });

  test(`${lane} release names its code the way that lane builds`, () => {
    // Without a database, so the proxy's own --image cannot stand in for the
    // release container's.
    const argv = releaseJobArgs(job(lane, { cloudsql: null }));
    if (lane === "buildpack") {
      assert.ok(argv.includes("--source"));
      assert.ok(!argv.includes("--image"));
    } else {
      assert.equal(argv[argv.indexOf("--image") + 1], "img:latest");
      assert.ok(!argv.includes("--source"));
    }
  });

  test(`${lane} release is deployed as a job, under a name a redeploy reuses`, () => {
    const argv = releaseJobArgs(job(lane));
    assert.deepEqual(argv.slice(0, 4), ["run", "jobs", "deploy", "demo-release"]);
    // create-or-update, so the second deploy of the same app must address the
    // same job. A fresh name per deploy leaves one dead job per release behind.
    assert.deepEqual(releaseJobArgs(job(lane)), argv);
  });

  test(`${lane} release does not carry flags a job rejects`, () => {
    const argv = releaseJobArgs(job(lane));
    // Passing the service's deployFlags through here fails on the first of
    // these with "unrecognized arguments", after the build, for a reason that
    // has nothing to do with the app.
    for (const flag of ["--allow-unauthenticated", "--no-allow-unauthenticated", "--concurrency", "--cpu-boost", "--max-instances"]) {
      assert.ok(!argv.some((a) => a === flag || a.startsWith(`${flag}=`)), `a job rejects ${flag}`);
    }
    assert.ok(argv.some((a) => a.startsWith("--labels=")), "jobs take --labels, not --update-labels");
    assert.ok(!argv.some((a) => a.startsWith("--update-labels=")));
  });
}

test("a release command with a comma survives the argv", () => {
  const release = `psql -c "SELECT a,b FROM t"`;
  const argv = releaseJobArgs(job("container", { release, cloudsql: null }));
  assert.ok(argv.includes(`--args=^~~^-c~~${release}`));
});

test("the proxy wait is bounded, POSIX, and probes for its tools", () => {
  const wait = proxyWait("127.0.0.1", "5432", 30);
  assert.ok(wait.includes("command -v"), "a missing interpreter must not hang the release");
  assert.ok(wait.includes("[ $i -lt 30 ]"), "an unbounded wait turns a slow proxy into a task timeout");
  assert.ok(!wait.includes("~~"), "the delimiter would split the command it is embedded in");

  // `/dev/tcp` is bash-only and the customer's /bin/sh is usually dash — so it is
  // allowed ONLY inside a `bash -c`, guarded by `command -v bash`. Inline, it is
  // a redirect dash cannot perform. This assertion replaces a flat ban: the ban
  // was right while this string only ever ran in the runner's Node and Python
  // images, and became wrong the moment it started prefixing a Go container's
  // CMD, where bash is the only one of the four probes that exists.
  assert.ok(wait.includes("command -v bash >/dev/null 2>&1 && bash -c 'exec 3<>/dev/tcp/"),
    "the /dev/tcp probe must be guarded and run through bash, never inline");
  assert.doesNotMatch(wait.replace(/bash -c '[^']*'/g, ""), /\/dev\/tcp/,
    "no unguarded /dev/tcp outside the bash -c");
});

test("an image with none of the four probes waits zero seconds, not thirty", () => {
  // The loop had no early exit for "none of these tools is here": it ran the full
  // count sleeping one second per iteration and then fell through. On the runner
  // that never happened — every image was Node or Python. Prefixed to a generated
  // Go, Rust or Java image it is a silent 30-second penalty on every cold start,
  // which reads as the platform being slow and appears in no log.
  const wait = proxyWait("127.0.0.1", "5432", 30);
  const guard = wait.slice(0, wait.indexOf("then"));
  for (const tool of ["nc", "python3", "node", "bash"]) {
    assert.ok(guard.includes(`command -v ${tool} `), `${tool} is not in the availability guard`);
  }
  // The loop is INSIDE the guard, so a shell that finds nothing skips it whole.
  assert.ok(wait.indexOf("while") > wait.indexOf("then"));
  assert.ok(wait.trimEnd().endsWith("fi;"));
});

test("executing waits for the verdict, on the job the deploy just wrote", () => {
  const argv = releaseExecuteArgs(job("container"));
  assert.deepEqual(argv.slice(0, 4), ["run", "jobs", "execute", "demo-release"]);
  // Without --wait, gcloud exits 0 as soon as the execution STARTS, and the
  // pointer would move over a migration still running — which is the failure
  // mode this phase exists to remove, reintroduced by one missing flag.
  assert.ok(argv.includes("--wait"));
  assert.ok(!argv.includes("--async"));
  assert.equal(releaseJobArgs(job("container"))[3], argv[3]);
});

test("a failed release can be read back, because the verdict says nothing", () => {
  const argv = releaseLogsArgs(job("container"));
  assert.deepEqual(argv.slice(0, 6), ["beta", "run", "jobs", "logs", "read", "demo-release"]);
  assert.ok(argv.includes("--limit=50"));
});

test("a sibling gets its own job, because it has its own release command", () => {
  assert.notEqual(releaseJobName("demo"), releaseJobName("demo-api"));
  assert.ok(releaseJobName("demo-api").endsWith("-release"));
  // Cloud Run's job names are capped at 63 characters, and the suffix has to
  // survive the cap or two long-prefixed apps truncate onto one job.
  const long = releaseJobName("a".repeat(80));
  assert.ok(long.length <= 63 && long.endsWith("-release"));
});

test("the static lane has no release phase, and says so", () => {
  assert.throws(() => releaseJobArgs(job("static" as Lane)), /static lane has no release phase/);
});

test("a job with neither an image nor a source is refused, naming the lane", () => {
  assert.throws(() => releaseJobArgs(job("container", { image: undefined })), /lane "container" needs an image or a source/);
});

test("an empty release command is refused rather than executed", () => {
  // An empty `--args=-c` would exec /bin/sh with no script, exit 0, and report
  // a release that never ran as a release that succeeded.
  assert.throws(() => releaseJobArgs(job("container", { release: "   " })), /has no release command/);
});

/**
 * The release is a LANE question, and the pipeline asked the LANGUAGE.
 *
 * `planFromConfig` puts `release` on `preRun` whatever the service says it is
 * written in, but the pipeline only read `preRun` inside the branch for Node and
 * Python. `language: "other"` — the schema's own spelling for "I committed a
 * Dockerfile, build that" — therefore reached the container lane with no release
 * command, and `runRelease` returns early on an empty one. No job, no migration,
 * no log line, and a deploy that reports success.
 */
test("a release survives a language the runner has no lane for", () => {
  // The plan shape is identical for all three — `planFromConfig` reads `release`
  // without looking at `language` — so what is asserted here is that nothing
  // downstream reintroduces the distinction.
  assert.equal(releaseFromPlan({ preRun: ["prisma migrate deploy"] }), "prisma migrate deploy");
});

test("several release steps become one command, in order", () => {
  assert.equal(
    releaseFromPlan({ preRun: ["python manage.py migrate", "", "python manage.py collectstatic"] }),
    "python manage.py migrate && python manage.py collectstatic",
  );
});

test("a static site has no release, because there is nothing to run before traffic", () => {
  // Not a language exception — LANE_CONSUMES and releaseJobArgs both refuse it
  // too, and three agreeing is the point.
  assert.equal(releaseFromPlan({ static: true, preRun: ["prisma migrate deploy"] }), "");
  assert.equal(releaseFromPlan({}), "");
});
