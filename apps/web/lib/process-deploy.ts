import { dbProxyContainer, dbContainerArgs, type Lane } from "./lanes";
import { proxyWait } from "./release-job";
import { cloudRunName } from "./slug";
import { PRIMITIVE, type ResolvedProcess, type WebProcess, type WorkerProcess, type TaskProcess } from "./processes";

/**
 * One process, turned into the argv for the Cloud Run primitive that fits it.
 *
 * `lanes.ts` does this for a service and `release-job.ts` for the release job.
 * This is the same job for the two primitives that had no emitter at all — a
 * worker pool and a scheduled job — plus the one flag `web` was missing.
 *
 * Deliberately pure. Every function here returns an array of strings and touches
 * nothing: that is what let `lanes.ts` and `release-job.ts` be tested against
 * what gcloud would actually receive, and it is the only reason the flag
 * mistakes in this file's comments were catchable before a nine-minute build.
 *
 * These are DESIRED-STATE emitters. The service path is stuck on
 * `--update-env-vars` until step 4 because changing it mid-flight would rewrite
 * live services; these two primitives have no deployed instances anywhere, so
 * they are born reconciled — `--set-env-vars` and `--clear-env-vars`, never a
 * merge. A worker that drops a variable from its config has it gone from the
 * next revision, which is the property the whole plan is for.
 */

/**
 * The Cloud Run resource name for one process of one service.
 *
 * `cloudRunName` caps at 49 characters, leaving room for the suffix inside Cloud
 * Run's 63-character limit — the same reasoning `releaseJobName` already
 * documents, and the same trap: suffixing before the cap would let two apps with
 * a long shared prefix truncate onto the same resource.
 *
 * The `web` process takes the service's own name with no suffix, because it IS
 * the service — a Cloud Run service called `myapp-web` beside a domain mapping
 * for `myapp` would be a rename of every app that already exists.
 */
export function processResourceName(service: string, process: ResolvedProcess): string {
  if (process.kind === "web") return cloudRunName(service);
  return `${cloudRunName(service)}-${cloudRunName(process.name)}`;
}

export interface ProcessDeploy {
  /** The app's Cloud Run service name — the base every process name is built from. */
  service: string;
  /**
   * How the app was built, because it decides how a command is delivered.
   *
   * On the runner lane the image is a SHARED base whose entrypoint fetches the
   * app's bundle from GCS and execs `$SUPERSONIC_RUN`. Overriding its entrypoint
   * with `--command`/`--args` would run the worker's command against an empty
   * /app — the container would start, find no code, and fail in a way that looks
   * like the app being broken. So there the command travels as env instead.
   *
   * Every other lane runs the app's OWN image, whose CMD is the web server; there
   * the command HAS to be overridden or the worker would serve HTTP.
   *
   * Exactly the split `releaseJobArgs` already makes, for exactly the same
   * reason. Made once here rather than at each of the two call sites, because a
   * rule with two readers is the defect this plan is named after.
   */
  lane: Lane;
  region: string;
  project: string;
  /** runner + container lanes. One of image/source is required. */
  image?: string;
  /** buildpack lane: the directory to build from. */
  source?: string;
  serviceAccount?: string;
  /** `key=value` pairs for `--labels`. */
  labels?: string[];
  /** Plain `KEY=value` strings. */
  env: string[];
  /** The `--set-secrets` value, `KEY=secret:latest,…`, or null. */
  secrets?: string | null;
  /** Cloud SQL connection name, or null when the process has no database. */
  cloudsql?: string | null;
}

/**
 * `^~~^` picks a non-comma delimiter for one flag value.
 *
 * Required, not stylistic. `--set-env-vars` and `--args` are comma-separated, so
 * a DSN containing a comma or a command like `psql -c "SELECT a,b"` is otherwise
 * split into two entries. The same escape `deploy-pipeline` and `release-job`
 * already use, spelled once here so a third variant cannot appear.
 */
const DELIM = "^~~^";

/** The pairs with `name` set to `value`, and any earlier spelling of it gone. */
function withEnv(pairs: string[], name: string, value: string): string[] {
  return [...pairs.filter((p) => !p.startsWith(`${name}=`)), `${name}=${value}`];
}

function envFlags(env: string[]): string[] {
  // Cleared rather than omitted when empty. Omitting leaves whatever the previous
  // revision had, which is the merge-forever behaviour this emitter exists to not
  // have; these primitives are new, so there is no working app to protect from
  // the stricter rule.
  return env.length ? [`--set-env-vars=${DELIM}${env.join("~~")}`] : ["--clear-env-vars"];
}

function secretFlags(secrets: string | null | undefined): string[] {
  return secrets ? [`--set-secrets=${secrets}`] : ["--clear-secrets"];
}

/**
 * The command, wrapped so a shell string survives being an argv list.
 *
 * `--args` is comma-separated (see DELIM), and an app's start command is a shell
 * line — pipes, `&&`, quoted arguments — not an argv. `/bin/sh -c` is the only
 * thing that reads one correctly, and it is what `release-job.ts` already does
 * for every non-runner lane.
 *
 * The proxy wait goes in FRONT of the command rather than being expressed as
 * container ordering. See `workerPoolArgs` for why that is not a shortcut.
 */
function shellCommand(command: string, cloudsql: string | null | undefined): string[] {
  return ["--command=/bin/sh", `--args=${DELIM}-c~~${cloudsql ? proxyWait() : ""}${command}`];
}

/**
 * How this process is told what to run, and the env that goes with it.
 *
 * Two answers, decided by the lane — see `ProcessDeploy.lane`. On the runner the
 * command is `SUPERSONIC_RUN` and the image's own entrypoint stays; everywhere
 * else the entrypoint is replaced, because the app's image starts a web server.
 *
 * The proxy wait is only needed on the second path: the runner's entrypoint
 * already waits for PGHOST itself (services/runner/entrypoint.sh), and doing it
 * twice would just be thirty more seconds in the worst case.
 */
function delivery(d: ProcessDeploy, command: string): { env: string[]; command: string[] } {
  if (d.lane === "runner") return { env: withEnv(d.env, "SUPERSONIC_RUN", command), command: [] };
  return { env: d.env, command: shellCommand(command, d.cloudsql) };
}

/**
 * `gcloud beta run worker-pools deploy` argv for one worker.
 *
 * This is the primitive a Telegram bot needs and the reason the whole plan is
 * shaped this way. A Cloud Run SERVICE will not serve a revision until its
 * startup probe reaches $PORT, so a process with no HTTP has to fake a listener
 * to exist — and then Cloud Run throttles its CPU to near-zero between the
 * requests it is not receiving. A worker pool has no endpoint, no port and no
 * probe, and its CPU is always allocated.
 *
 * `beta`, deliberately spelled out: worker pools are not in the GA track on SDK
 * 539.0.0, and `gcloud run worker-pools` fails with "Invalid choice". Better to
 * carry the track in the argv, where a test can see it, than to discover it from
 * a deploy.
 *
 * Flags NOT here, because a worker pool rejects them outright: `--port`,
 * `--allow-unauthenticated`, `--concurrency`, `--timeout`, `--max-instances`,
 * `--cpu-boost` and every probe flag. That list is why `WorkerProcess` carries
 * `instances`, `memory` and `cpu` and nothing else — a shared `Scale` would have
 * accepted four fields this primitive cannot express and dropped them silently,
 * which is the defect the previous plan spent itself closing.
 */
export function workerPoolArgs(d: ProcessDeploy, p: WorkerProcess): string[] {
  if (!d.image && !d.source) throw new Error(`worker "${p.name}" needs an image or a source directory`);

  const run = delivery(d, p.command);
  return [
    "beta", "run", "worker-pools", "deploy", processResourceName(d.service, p),
    "--region", d.region, "--project", d.project, "--format=json",
    ...(d.serviceAccount ? [`--service-account=${d.serviceAccount}`] : []),
    ...(d.labels?.length ? [`--labels=${d.labels.join(",")}`] : []),
    // A fixed instance count. `--scaling` takes a positive integer on this SDK
    // and nothing else — there is no target-utilisation form to pass through, so
    // the schema does not pretend to have one.
    `--scaling=${p.instances}`,
    // Named, because the Cloud SQL sidecar below makes this a multi-container
    // pool and Cloud Run then requires every container to be identified. Named
    // unconditionally rather than only when there is a database, because the
    // container set is not idempotent: adding a name to a pool deployed without
    // one rewrites its containers, which is exactly the trap `existingScoped`
    // exists to work around on the service path. A pool that is named from its
    // first revision never has that transition to survive.
    "--container", "app",
    ...(d.image ? ["--image", d.image] : ["--source", d.source!]),
    "--memory", p.memory, "--cpu", String(p.cpu),
    ...run.command,
    ...envFlags(run.env),
    ...secretFlags(d.secrets),
    // The sidecar WITHOUT `--depends-on`, and that is a decision rather than an
    // omission.
    //
    // Cloud Run refuses any revision whose `--depends-on` names a container with
    // no startup probe — the failure `dbContainerArgs` documents at length. A
    // worker pool exposes no probe flag at all, so the precondition for
    // `--depends-on` cannot be met here, and emitting a flag whose requirement we
    // cannot satisfy would be a revision rejected after the build for a reason
    // that has nothing to do with the app.
    //
    // Ordering is handled where it is already handled for every non-runner
    // release: `proxyWait()` in front of the command, so the process waits for
    // 127.0.0.1:5432 to answer instead of relying on container start order. That
    // is strictly stronger than `--depends-on`, which orders START and not port
    // readiness — the race `entrypoint.sh` documents losing.
    ...(d.cloudsql ? dbProxyContainer(d.cloudsql) : []),
  ];
}

/**
 * `gcloud run jobs deploy` argv for one cron process.
 *
 * The job, not the schedule — `cronScheduleArgs` is what makes it recurring. Two
 * commands for the same reason `releaseJobArgs` is separate from
 * `releaseExecuteArgs`: a job that cannot be CONFIGURED is a platform failure and
 * a job that RAN and exited non-zero is the app's, and one exit code for both
 * makes every failure look like the app's fault.
 *
 * What this replaces: today a cron is a Cloud Scheduler HTTP ping at the app's
 * own URL (`app/api/apps/[slug]/jobs/route.ts`), so a nightly export runs as a
 * request inside the web service — capped by the service's request timeout,
 * sharing instances with user traffic at concurrency 80, and holding an instance
 * open for its whole duration. A job runs on its own, sized on its own, with its
 * own timeout, and nothing it does can slow a user's request down.
 */
export function cronJobArgs(d: ProcessDeploy, p: TaskProcess): string[] {
  if (!d.image && !d.source) throw new Error(`process "${p.name}" needs an image or a source directory`);

  const run = delivery(d, p.command);
  return [
    "run", "jobs", "deploy", processResourceName(d.service, p),
    "--region", d.region, "--project", d.project, "--format=json",
    ...(d.serviceAccount ? [`--service-account=${d.serviceAccount}`] : []),
    // `--labels`, not `--update-labels`: a job rejects the second, which is the
    // mistake `releaseJobArgs` already carries a comment about.
    ...(d.labels?.length ? [`--labels=${d.labels.join(",")}`] : []),
    `--max-retries=${p.retries}`,
    "--tasks=1", "--parallelism=1",
    `--task-timeout=${p.taskTimeout}s`,
    // Declared FIRST, and that ordering is load-bearing. A job has no ingress
    // container to identify the main one by, so Cloud Run takes the first,
    // ends the task when it exits and stops the rest. Declared the other way
    // round the task would wait on a Cloud SQL proxy, which never exits on its
    // own, and every run would be "failed" at the task timeout with a successful
    // job behind it.
    "--container", "app",
    ...(d.image ? ["--image", d.image] : ["--source", d.source!]),
    "--memory", p.memory, "--cpu", String(p.cpu),
    ...run.command,
    ...envFlags(run.env),
    ...secretFlags(d.secrets),
    // A job DOES take probes, so the full sidecar with `--depends-on` applies
    // here — unlike the worker pool above. Same rule, different primitive.
    ...(d.cloudsql ? ["--depends-on", "cloudsql-proxy", ...dbContainerArgs(d.cloudsql)] : []),
  ];
}

/**
 * The Cloud Run Admin API endpoint that runs a job.
 *
 * A scheduled job is triggered by calling this, not by calling the app. That is
 * the whole difference from what exists today.
 */
export function jobRunUri(region: string, project: string, jobName: string): string {
  return `https://${region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${project}/jobs/${jobName}:run`;
}

export interface Scheduled {
  /** The identity Cloud Scheduler authenticates as. */
  schedulerServiceAccount: string;
}

/**
 * `gcloud scheduler jobs create http` argv for one cron process.
 *
 * **OAuth, not OIDC**, and the difference is the whole reason this function is
 * not a small edit to the existing one. OIDC mints an identity token for an
 * arbitrary audience, which is right for calling a private Cloud Run SERVICE;
 * the target here is `run.googleapis.com`, a Google API, and a Google API wants
 * an OAuth access token with the cloud-platform scope. Sending the wrong one
 * gets a 401 from a job that looks correctly configured.
 *
 * This is also the fix for a live latent break. `createJob` in lib/gcloud.ts
 * passes no auth flag at all, and `grantInvokers` binds only the proxy service
 * account and the control plane. That works today solely because `SEAL_APPS`
 * defaults off and apps deploy `--allow-unauthenticated`; the day that flips,
 * every customer's cron starts silently 403-ing with nothing in the app's own
 * logs to say so.
 */
export function cronScheduleArgs(
  d: Pick<ProcessDeploy, "service" | "region" | "project">,
  p: TaskProcess,
  s: Scheduled,
): string[] {
  if (!p.schedule) throw new Error(`process "${p.name}" is scheduled and has no schedule`);

  const job = processResourceName(d.service, p);
  return [
    "scheduler", "jobs", "create", "http", job,
    "--location", d.region, "--project", d.project,
    `--schedule=${p.schedule}`,
    // Cloud Scheduler defaults to UTC when this is absent, so it is only sent
    // when the author said which zone they meant. "0 3 * * *" is 3am somewhere,
    // and a nightly report firing at 3am UTC for a business in Almaty runs at
    // 8am — during the working day, against live traffic.
    ...(p.timezone ? [`--time-zone=${p.timezone}`] : []),
    `--uri=${jobRunUri(d.region, d.project, job)}`,
    "--http-method=POST",
    `--oauth-service-account-email=${s.schedulerServiceAccount}`,
  ];
}

/**
 * The same schedule as an update.
 *
 * `gcloud scheduler jobs create` is not create-or-update — it fails with ALREADY
 * EXISTS on the second deploy of an unchanged app, which would make every
 * redeploy of a CRM fail on a cron that was already correct. The caller tries
 * update first and falls back to create, which is the shape `run jobs deploy`
 * gives for free and Scheduler does not.
 */
export function cronScheduleUpdateArgs(
  d: Pick<ProcessDeploy, "service" | "region" | "project">,
  p: TaskProcess,
  s: Scheduled,
): string[] {
  return cronScheduleArgs(d, p, s).map((a) => (a === "create" ? "update" : a));
}

/**
 * The service-level flags a `web` process adds beyond what `deployArgs` builds.
 *
 * One flag today, and it is the one that makes an agent server's private API
 * expressible: `--ingress=internal` accepts traffic from inside the VPC and from
 * other Cloud Run services in the project, and nothing from the internet.
 *
 * `--ingress=all` is stated explicitly rather than omitted for public. Omitting
 * it leaves whatever the service already had, so an app that was internal and
 * becomes public would stay unreachable with a config that says otherwise — a
 * silent no-op on the one field whose whole purpose is to be observable.
 */
export function webIngressFlags(p: WebProcess): string[] {
  return [`--ingress=${p.visibility === "internal" ? "internal" : "all"}`];
}

/** The gcloud argv for whichever primitive this process runs on. */
export function processArgs(d: ProcessDeploy, p: ResolvedProcess): string[] {
  switch (PRIMITIVE[p.kind]) {
    case "worker-pool": return workerPoolArgs(d, p as WorkerProcess);
    case "job": return cronJobArgs(d, p as TaskProcess);
    // `web` is not emitted here. It goes through `deployArgs` in lib/lanes.ts,
    // unchanged, because there are live services on that path and this plan does
    // not smuggle a migration for them into a step about workers. The only thing
    // `web` gains at this step is `webIngressFlags`.
    default: throw new Error(`process "${p.name}" is a web process — deploy it with deployArgs and webIngressFlags`);
  }
}
