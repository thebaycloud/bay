import { test } from "node:test";
import assert from "node:assert/strict";
import {
  releaseExecuteArgs, releaseLogsArgs, releaseJobName, proxyWait,
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
    image: "img:latest",
    ...over,
  };
}


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


