import { test } from "node:test";
import assert from "node:assert/strict";
import {
  workerPoolArgs, cronJobArgs, cronScheduleArgs, cronScheduleUpdateArgs,
  appPingScheduleArgs,
  webIngressFlags, processArgs, processResourceName, jobRunUri,
  type ProcessDeploy,
} from "../lib/process-deploy";
import { resolveProcess, type WebProcess, type WorkerProcess, type TaskProcess } from "../lib/processes";

const base: ProcessDeploy = {
  service: "myapp",
  lane: "container" as const,
  region: "us-central1",
  project: "supersonic-deploy-prod",
  image: "us-central1-docker.pkg.dev/p/r/myapp:latest",
  serviceAccount: "apps@p.iam.gserviceaccount.com",
  labels: ["supersonic-name=myapp"],
  env: ["LOG_LEVEL=info"],
  secrets: "TOKEN=myapp-TOKEN:latest",
};

const worker = resolveProcess("bot", { command: "python bot.py" }) as WorkerProcess;
const cron = resolveProcess("nightly", { command: "python manage.py digest", schedule: "0 3 * * *" }) as TaskProcess;

/** The value of a `--flag=value` token, or undefined. */
const valueOf = (argv: string[], flag: string) =>
  argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);

test("a worker deploys to a worker pool, on the beta track, with no port", () => {
  const argv = workerPoolArgs(base, worker);

  // `gcloud run worker-pools` fails with "Invalid choice" on SDK 539.0.0 — the
  // track is part of the argv so a test can see it rather than a deploy.
  assert.deepEqual(argv.slice(0, 5), ["beta", "run", "worker-pools", "deploy", "myapp-bot"]);

  // The whole point: nothing here asks the process to answer HTTP. A Cloud Run
  // SERVICE refuses to serve a revision until its startup probe reaches $PORT,
  // which is why a bot on that primitive has to fake a listener.
  for (const rejected of ["--port", "--allow-unauthenticated", "--concurrency", "--timeout", "--max-instances", "--cpu-boost", "--startup-probe"]) {
    assert.ok(
      !argv.some((a) => a === rejected || a.startsWith(`${rejected}=`)),
      `a worker pool rejects ${rejected} and the argv carried it`,
    );
  }
});

test("a worker's size is a fixed instance count, cpu and memory — nothing else", () => {
  assert.equal(valueOf(workerPoolArgs(base, worker), "--scaling"), "1");

  const three = resolveProcess("bot", { command: "python bot.py", instances: 3, memory: "512Mi", cpu: 2 }) as WorkerProcess;
  const argv = workerPoolArgs(base, three);
  assert.equal(valueOf(argv, "--scaling"), "3");
  assert.equal(argv[argv.indexOf("--memory") + 1], "512Mi");
  assert.equal(argv[argv.indexOf("--cpu") + 1], "2");
});

test("worker and cron env is SET, not merged", () => {
  // These primitives have no deployed instances anywhere, so they are born
  // reconciled: a variable dropped from the config is gone from the next
  // revision. The service path stays on --update-env-vars until step 4, where
  // changing it means rewriting live services.
  for (const argv of [workerPoolArgs(base, worker), cronJobArgs(base, cron)]) {
    assert.ok(argv.some((a) => a.startsWith("--set-env-vars=")));
    assert.ok(!argv.some((a) => a.startsWith("--update-env-vars=")));
    assert.ok(!argv.some((a) => a.startsWith("--update-secrets=")));
  }
});

test("an empty environment clears rather than inherits", () => {
  const argv = workerPoolArgs({ ...base, env: [], secrets: null }, worker);

  assert.ok(argv.includes("--clear-env-vars"));
  assert.ok(argv.includes("--clear-secrets"));
  // Both forms would be a contradiction gcloud rejects.
  assert.ok(!argv.some((a) => a.startsWith("--set-env-vars=")));
});

test("the delimiter escape survives a value containing a comma", () => {
  const argv = workerPoolArgs(
    { ...base, env: ["DSN=postgres://u:p@h/db?opts=a,b", "LOG_LEVEL=info"] },
    worker,
  );

  // Without ^~~^ the DSN's comma splits it into two env entries, and the app
  // gets a truncated connection string with no error anywhere.
  const flag = argv.find((a) => a.startsWith("--set-env-vars="))!;
  assert.ok(flag.startsWith("--set-env-vars=^~~^"));
  assert.ok(flag.includes("opts=a,b"));
});

test("a shell command is run through sh -c, so pipes and && survive", () => {
  const chained = resolveProcess("bot", { command: "python -m migrate && python bot.py" }) as WorkerProcess;
  const argv = workerPoolArgs(base, chained);

  assert.ok(argv.includes("--command=/bin/sh"));
  const args = argv.find((a) => a.startsWith("--args="))!;
  assert.ok(args.startsWith("--args=^~~^-c~~"));
  assert.ok(args.endsWith("python -m migrate && python bot.py"));
});

test("a worker with a database waits for the proxy instead of depending on it", () => {
  const argv = workerPoolArgs({ ...base, cloudsql: "p:us-central1:pg" }, worker);

  // Cloud Run refuses a revision whose --depends-on names a container with no
  // startup probe, and a worker pool has no probe flag at all — so the
  // precondition cannot be met and the flag is not sent.
  assert.ok(!argv.includes("--depends-on"));
  assert.ok(!argv.some((a) => a.startsWith("--startup-probe")));

  // The sidecar is still there, from the same source as every other lane's.
  assert.ok(argv.includes("cloudsql-proxy"));
  assert.ok(argv.some((a) => a.startsWith("--args=--port=5432,--address=127.0.0.1")));

  // And ordering is handled in front of the command, which is stronger than
  // --depends-on anyway: that orders container START, not port readiness.
  const args = argv.find((a) => a.startsWith("--args=^~~^-c~~"))!;
  assert.match(args, /while \[ \$i -lt 30 \]/);
  assert.ok(args.endsWith("python bot.py"));
});

test("a worker without a database has no proxy and no wait", () => {
  const argv = workerPoolArgs({ ...base, cloudsql: null }, worker);

  assert.ok(!argv.includes("cloudsql-proxy"));
  assert.equal(argv.find((a) => a.startsWith("--args=")), "--args=^~~^-c~~python bot.py");
});

test("a cron is its own job, not a request against the web service", () => {
  const argv = cronJobArgs(base, cron);

  assert.deepEqual(argv.slice(0, 5), ["run", "jobs", "deploy", "myapp-nightly", "--region"]);
  // Its own timeout, so a nightly export is not capped by the web service's
  // request timeout and does not hold a serving instance open for its duration.
  assert.ok(argv.includes("--task-timeout=1800s"));
  assert.ok(argv.includes("--max-retries=0"));
  assert.ok(argv.includes("--tasks=1"));
  // `--labels`, not `--update-labels`: a job rejects the second outright.
  assert.ok(argv.some((a) => a.startsWith("--labels=")));
  assert.ok(!argv.some((a) => a.startsWith("--update-labels=")));
});

test("a job DOES take probes, so its sidecar keeps depends-on", () => {
  const argv = cronJobArgs({ ...base, cloudsql: "p:us-central1:pg" }, cron);

  assert.ok(argv.includes("--depends-on"));
  assert.ok(argv.some((a) => a.startsWith("--startup-probe=")));
  // The app container is declared FIRST: a job has no ingress container, so
  // Cloud Run ends the task when the first one exits. The other way round every
  // run waits on a proxy that never exits and "fails" at the task timeout.
  assert.ok(argv.indexOf("app") < argv.indexOf("cloudsql-proxy"));
});

test("the schedule triggers the JOB and authenticates with OAuth, not OIDC", () => {
  const argv = cronScheduleArgs(base, cron, { schedulerServiceAccount: "sched@p.iam.gserviceaccount.com" });

  assert.deepEqual(argv.slice(0, 5), ["scheduler", "jobs", "create", "http", "myapp-nightly"]);
  assert.equal(valueOf(argv, "--schedule"), "0 3 * * *");
  assert.equal(
    valueOf(argv, "--uri"),
    "https://us-central1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/supersonic-deploy-prod/jobs/myapp-nightly:run",
  );

  // The target is a Google API, which wants an OAuth access token. OIDC mints an
  // identity token for an arbitrary audience — right for a private Cloud Run
  // service, a 401 here.
  assert.ok(argv.some((a) => a.startsWith("--oauth-service-account-email=")));
  assert.ok(!argv.some((a) => a.startsWith("--oidc-")));

  // And an auth flag is present at all, which is the live latent break: createJob
  // in lib/gcloud.ts passes none, and that works only while SEAL_APPS is off.
  assert.ok(argv.some((a) => a.includes("service-account-email=")));
});

const ping = {
  id: "myapp--nightly",
  schedule: "0 3 * * *",
  serviceUrl: "https://myapp-abc123-uc.a.run.app",
  path: "/cron/digest",
  region: "us-central1",
  project: "supersonic-deploy-prod",
  schedulerServiceAccount: "sched@p.iam.gserviceaccount.com",
};

test("a cron created from the dashboard authenticates with OIDC, not OAuth", () => {
  const argv = appPingScheduleArgs(ping);

  assert.deepEqual(argv.slice(0, 5), ["scheduler", "jobs", "create", "http", "myapp--nightly"]);

  // The mirror image of the rule above, and the reason both live in one file.
  // This target is the app's own Cloud Run service, not a Google API, so the
  // identity token is the right token — gcloud's own help states the split:
  // OIDC everywhere except APIs on *.googleapis.com.
  assert.equal(valueOf(argv, "--oidc-service-account-email"), "sched@p.iam.gserviceaccount.com");
  assert.ok(!argv.some((a) => a.startsWith("--oauth-")));
});

test("the token is minted for the service and the request goes to the path", () => {
  const argv = appPingScheduleArgs(ping);

  // The service url is the audience Cloud Run documents, and the one probeApp
  // already relies on. Cloud Scheduler's own default — "the URI specified in
  // target", path included — was measured against a sealed app and also
  // accepted, so this pin buys explicitness rather than a fix: it stops the
  // cron resting on a tolerance nobody promised.
  assert.equal(valueOf(argv, "--oidc-token-audience"), "https://myapp-abc123-uc.a.run.app");
  assert.equal(valueOf(argv, "--uri"), "https://myapp-abc123-uc.a.run.app/cron/digest");
});

test("the audience is the uri's own origin, whatever shape the two arrive in", () => {
  // The caller cannot hand in a uri and an audience that disagree, because it
  // hands in neither. That is the whole reason this takes a url and a path: two
  // strings that must agree are two strings that eventually will not, and the
  // failure mode is a 403 a night, in a place nobody is looking.
  const odd = appPingScheduleArgs({ ...ping, serviceUrl: "https://myapp-abc123-uc.a.run.app/", path: "cron/digest" });

  assert.equal(valueOf(odd, "--uri"), "https://myapp-abc123-uc.a.run.app/cron/digest");
  assert.equal(valueOf(odd, "--oidc-token-audience"), "https://myapp-abc123-uc.a.run.app");
});

test("a timezone is sent only when the author said which one they meant", () => {
  const utc = cronScheduleArgs(base, cron, { schedulerServiceAccount: "s@p" });
  assert.ok(!utc.some((a) => a.startsWith("--time-zone=")));

  const local = resolveProcess("nightly", { command: "x", schedule: "0 3 * * *", timezone: "Asia/Almaty" }) as TaskProcess;
  assert.equal(valueOf(cronScheduleArgs(base, local, { schedulerServiceAccount: "s@p" }), "--time-zone"), "Asia/Almaty");
});

test("the schedule can be updated, because create is not create-or-update", () => {
  // `scheduler jobs create` fails ALREADY_EXISTS on the second deploy of an
  // unchanged app, which would fail every redeploy of a CRM on a cron that was
  // already correct.
  const update = cronScheduleUpdateArgs(base, cron, { schedulerServiceAccount: "s@p" });

  assert.deepEqual(update.slice(0, 4), ["scheduler", "jobs", "update", "http"]);
  assert.equal(update.filter((a) => a === "create").length, 0);
  // Everything else is identical, so the two cannot drift apart.
  const create = cronScheduleArgs(base, cron, { schedulerServiceAccount: "s@p" });
  assert.deepEqual(update.slice(4), create.slice(4));
});

test("an internal web says so explicitly, in both directions", () => {
  const priv = resolveProcess("web", { command: "npm start", visibility: "internal" }) as WebProcess;
  const pub = resolveProcess("web", { command: "npm start" }) as WebProcess;

  assert.deepEqual(webIngressFlags(priv), ["--ingress=internal"]);
  // Stated rather than omitted: omitting leaves whatever the service had, so an
  // app that was internal and becomes public would stay unreachable with a
  // config saying otherwise.
  assert.deepEqual(webIngressFlags(pub), ["--ingress=all"]);
});

test("web keeps the service's own name; everything else is suffixed", () => {
  const web = resolveProcess("web", { command: "npm start" }) as WebProcess;

  // A service called `myapp-web` beside a domain mapping for `myapp` would be a
  // rename of every app that already exists.
  assert.equal(processResourceName("myapp", web), "myapp");
  assert.equal(processResourceName("myapp", worker), "myapp-bot");
  assert.equal(processResourceName("myapp", cron), "myapp-nightly");
});

test("a long service name is capped before the suffix, not after", () => {
  // Suffixing before the cap would let two apps with a long shared prefix
  // truncate onto the same Cloud Run resource — the trap releaseJobName documents.
  const long = "a".repeat(80);
  const name = processResourceName(long, worker);

  assert.ok(name.length <= 63, `${name.length} exceeds Cloud Run's 63-character limit`);
  assert.ok(name.endsWith("-bot"));
});

test("processArgs routes each kind to its primitive, and refuses web", () => {
  assert.deepEqual(processArgs(base, worker).slice(0, 4), ["beta", "run", "worker-pools", "deploy"]);
  assert.deepEqual(processArgs(base, cron).slice(0, 3), ["run", "jobs", "deploy"]);

  const release = resolveProcess("release", { command: "python manage.py migrate" }) as TaskProcess;
  assert.deepEqual(processArgs(base, release).slice(0, 3), ["run", "jobs", "deploy"]);

  const web = resolveProcess("web", { command: "npm start" }) as WebProcess;
  assert.throws(() => processArgs(base, web), /deployArgs and webIngressFlags/);
});

test("a process with nothing to run refuses before anything is built", () => {
  assert.throws(() => workerPoolArgs({ ...base, image: undefined }, worker), /needs an image or a source/);
  assert.throws(() => cronJobArgs({ ...base, image: undefined }, cron), /needs an image or a source/);
});

test("the buildpack lane deploys a worker from source", () => {
  const argv = workerPoolArgs({ ...base, image: undefined, source: "/tmp/repo" }, worker);

  assert.equal(argv[argv.indexOf("--source") + 1], "/tmp/repo");
  assert.ok(!argv.includes("--image"));
});

test("jobRunUri names the region twice on purpose — host and path differ", () => {
  assert.equal(
    jobRunUri("europe-west1", "proj", "job"),
    "https://europe-west1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/proj/jobs/job:run",
  );
});

test("on the runner lane the command travels as env, not as an entrypoint override", () => {
  // The runner image is a SHARED base whose entrypoint fetches the app's bundle
  // from GCS and execs $SUPERSONIC_RUN. Overriding it with --command/--args would
  // run the worker against an empty /app: the container starts, finds no code,
  // and fails in a way that reads as the app being broken. Exactly the split
  // releaseJobArgs already makes, made once so it cannot drift.
  const argv = workerPoolArgs({ ...base, lane: "runner" }, worker);

  assert.ok(!argv.includes("--command=/bin/sh"));
  assert.ok(!argv.some((a) => a.startsWith("--args=^~~^-c~~")));
  assert.ok(argv.some((a) => a.includes("SUPERSONIC_RUN=python bot.py")));
});

test("SUPERSONIC_RUN replaces the web command rather than appearing twice", () => {
  // The env handed in is the primary service's, which on the runner lane already
  // carries the WEB process's SUPERSONIC_RUN. Two values in one --set-env-vars
  // leaves which one wins up to gcloud, and the worker would serve HTTP.
  const argv = workerPoolArgs(
    { ...base, lane: "runner", env: ["SUPERSONIC_RUN=npm start", "LOG_LEVEL=info"] },
    worker,
  );

  const flag = argv.find((a) => a.startsWith("--set-env-vars="))!;
  assert.equal(flag.split("~~").filter((p) => p.startsWith("SUPERSONIC_RUN=")).length, 1);
  assert.ok(flag.includes("SUPERSONIC_RUN=python bot.py"));
  assert.ok(!flag.includes("SUPERSONIC_RUN=npm start"));
});

test("a runner-lane worker relies on the entrypoint's own proxy wait", () => {
  // services/runner/entrypoint.sh already waits for PGHOST before it execs, so a
  // second wait in front of the command would only cost thirty more seconds in
  // the worst case — and there is no command to put it in front of here anyway.
  const argv = workerPoolArgs({ ...base, lane: "runner", cloudsql: "p:us-central1:pg" }, worker);

  assert.ok(!argv.some((a) => a.includes("while [ $i -lt 30 ]")));
  assert.ok(argv.includes("cloudsql-proxy"));
});
