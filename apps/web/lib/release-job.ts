import { dbContainerArgs, DB_HOST, DB_PORT, type Lane, type Scale } from "./lanes";
import { cloudRunName } from "./slug";

/**
 * The release phase: the one-shot work that runs ONCE, before any traffic.
 *
 * app-config.ts states exactly why folding it into the start command is wrong —
 * "folded into the start command, a migration re-runs on every cold start and
 * every scale-out instance, concurrently. Prisma takes an advisory lock and
 * survives that; Alembic does not" — and then every lane folds it into the start
 * command anyway. What that buys, live: concurrent migrations the moment the app
 * scales out, a failed migration crash-looping every instance with no rollback
 * boundary, migration time charged to every cold start, and Cloud Run's startup
 * probe free to kill the container half way through an ALTER TABLE.
 *
 * It cannot move into Cloud Build either, which is where it looks like it
 * belongs. app-secrets.ts does get DATABASE_URL into the build through
 * `availableSecrets` — but the address in that URL is 127.0.0.1:5432 and the
 * thing listening there is a Cloud Run SIDECAR (see dbContainerArgs). Cloud Build
 * has no sidecar, so the build holds a connection string pointing at a closed
 * port. Prisma passes only because `prisma generate` never opens a connection;
 * `manage.py migrate` hangs until the 1200s build timeout and then reports a
 * build failure that has nothing to do with the build.
 *
 * So the release runs as a Cloud Run JOB: same image or bundle, same
 * environment, same secrets, WITH the proxy attached, run to completion before
 * anything moves. Build / release / run, as Heroku has had it since 2011.
 *
 * What a failure means is the point of the phase, not a detail of it. The job
 * exits non-zero, `gcloud run deploy` is never called, no revision is created
 * and no traffic moves: the previous revision keeps serving against the schema
 * it was deployed with, which is the pair known to work. A migration that failed
 * half way is still half applied — nothing here can undo that — but the code in
 * front of it is code written for the schema that is actually there, which is
 * the opposite of what the fold-into-start behaviour produced.
 */

/**
 * The app's own container inside the release job.
 *
 * Named, always, unlike a service. deployArgs has to choose between the flat and
 * the scoped shape because naming the container of a live service that was last
 * deployed with an unnamed one rewrites its container set — but a release job has
 * no history that predates this module, so there is nothing to migrate and one
 * shape covers both cases. It is also forced as soon as the proxy is attached:
 * gcloud refuses any container-scoped flag on a multi-container job with "the
 * target job has multiple containers, a container name must be specified via
 * --container flag".
 */
export const RELEASE_CONTAINER = "release";

/**
 * Seconds a release may take before Cloud Run kills it.
 *
 * Cloud Run's own default is 600s, and being killed at 600s is the single worst
 * outcome available here: a migration interrupted mid-statement, a release
 * reported as failed, and a database left in a state neither revision was
 * written for. A first migration on a real schema, or a Django `collectstatic`
 * over a few thousand files, passes ten minutes without being remarkable. So the
 * default is generous and `taskTimeout` exists to raise it further.
 */
export const RELEASE_TIMEOUT = 1800;

export interface ReleaseJob {
  lane: Lane;
  /** The Cloud Run SERVICE this release belongs to. The job is named after it. */
  service: string;
  region: string;
  project: string;
  /**
   * The identity the SERVICE runs as. The release must be neither more nor less
   * privileged than the app: it reads the same secrets and, through the proxy,
   * needs the same roles/cloudsql.client.
   */
  serviceAccount?: string | null;
  /** `KEY=VALUE` label pairs. */
  labels?: string[];
  /** runner + container lanes. */
  image?: string;
  /** buildpack lane: the directory Cloud Run builds from. */
  source?: string;
  /** The one-shot command, already wrapped for its directory by resolve(). */
  release: string;
  /**
   * The same `KEY=VALUE` pairs the revision gets, not a subset.
   *
   * Taken as pairs rather than as the finished `appFlags` the service deploy
   * uses, because the runner lane's release has to REPLACE one of them
   * (SUPERSONIC_RUN) rather than add to them, and a second `--update-env-vars`
   * on one command line does not merge with the first — argparse keeps the last
   * occurrence, so appending would silently drop the app's entire environment.
   */
  env: string[];
  /** The `--update-secrets` value, `KEY=secret-name:latest,…`, or null. */
  secrets?: string | null;
  scale: Scale;
  /** Cloud SQL connection name, or null when the app has no database. */
  cloudsql?: string | null;
  /** Seconds. Defaults to RELEASE_TIMEOUT. */
  taskTimeout?: number;
}

/**
 * The one-shot command a plan carries, for any lane it could possibly run on.
 *
 * It exists as a function because the pipeline read it inside the branch that
 * handles Node and Python, and nowhere else. So `language: "other"` — which is
 * the schema's own spelling for tier 3, "I committed a Dockerfile, build that" —
 * reached the container lane with `releaseCmd` still `""`, and `runRelease`
 * returns early on an empty command. A container-lane app that declared
 * `release: "prisma migrate deploy"`, passed `supersonic check`, and watched the
 * check print the command back, deployed with no release job created at all and
 * no line of output saying so. Observed on umami: the deploy reported success,
 * the health path answered 200, and every page that read a table was an error.
 *
 * Which lane runs the release is a LANE question, and the lane is derived from
 * whether the author committed a Dockerfile — never from the language. The
 * database provisioning two lines below it already knew that, with a comment
 * saying so; the release was the last thing here still asking the language.
 *
 * Static is the one real exception, and it is not a language exception either: a
 * static site has nothing to run before traffic, which `LANE_CONSUMES` and
 * `releaseJobArgs` both already refuse.
 */
export function releaseFromPlan(plan: { static?: boolean; preRun?: string[] }): string {
  if (plan.static) return "";
  return (plan.preRun ?? []).filter(Boolean).join(" && ");
}

/**
 * One job per service, named deterministically so a redeploy updates it.
 *
 * `gcloud run jobs deploy` is create-or-update, so idempotence is entirely a
 * question of the name being the same next time — an app that minted a fresh
 * name per deploy would leave one dead job per release behind it, and the
 * failed one nobody wants to read would be indistinguishable from the current
 * one. Per SERVICE rather than per app because a sibling has its own image, its
 * own bundle and its own release command.
 */
export function releaseJobName(service: string): string {
  // cloudRunName caps at 49 characters, which leaves room for the suffix inside
  // Cloud Run's 63-character limit. Suffixing before the cap would let two apps
  // with a long shared prefix truncate onto the same job.
  return `${cloudRunName(service)}-release`;
}

/**
 * The env pairs with `name` set to `value`, and any earlier spelling of it gone.
 *
 * The runner lane's environment already carries SUPERSONIC_RUN — the app's START
 * command — because the release job is handed the same pairs the revision gets.
 * Appending a second one leaves which wins to how gcloud folds a repeated key,
 * and the losing outcome is the release job starting the web server instead of
 * running the migration: it binds $PORT, never exits, is killed at the task
 * timeout, and reports a failed release for an app that is entirely fine.
 */
function withEnv(pairs: string[], name: string, value: string): string[] {
  return [...pairs.filter((p) => !p.startsWith(`${name}=`)), `${name}=${value}`];
}

/**
 * A bounded wait for the proxy to accept a connection, as POSIX sh.
 *
 * `--depends-on` orders container START, not port readiness (#13). Cloud Run
 * starts the proxy first and then starts this container; the proxy still has to
 * reach Cloud SQL and bind. A release command that connects at import time —
 * which is every `manage.py`, every Alembic `env.py` — can lose that race and
 * die on "connection refused" against a proxy that was listening 200ms later.
 * That failure is indistinguishable from a database that does not exist.
 *
 * It gives up quietly instead of failing. The app's own connection error names
 * the database and the port; a wait loop that turned a slow proxy into a task
 * timeout would replace a diagnosable failure with an undiagnosable one. The loop
 * itself is written without bash-isms because it runs inside the customer's own
 * image, whose /bin/sh is usually dash, and it probes for its tools rather than
 * assuming them for the same reason.
 *
 * TWO CHANGES FOR THE GENERATED-IMAGE WORLD
 *
 * This used to run for workers, crons and release jobs only — all of which are
 * Node or Python, because they were runner bundles. Prefixed to a WEB command in
 * a generated image it can now land on Go, Rust and Java, and none of those base
 * images has `nc`, `python3` or `node`.
 *
 * So, first: a fourth probe. `bash` is present in every Debian- and Ubuntu-based
 * official language image — which is all of them, since dockerfile.ts ships the
 * full base rather than `-slim` — and `/dev/tcp` needs nothing else installed.
 * It is invoked through `bash -c` rather than used inline, because Debian's
 * `/bin/sh` is dash and would fail the redirect even where bash exists.
 *
 * Second, and this is the one that was costing real time: the loop had no early
 * exit for "none of these tools is here". It ran the full count, sleeping one
 * second per iteration, and then fell through — a silent 30-second penalty on
 * every cold start of every container that could not probe at all. Availability
 * is now checked once, before the loop, so an image with no probe waits zero
 * seconds instead of thirty and the app's own connect error arrives immediately.
 *
 * The runner lane does not use this: services/runner/entrypoint.sh waits for the
 * same port before it execs anything, which covers the runner's release job too
 * because the release job runs that same image through that same entrypoint.
 */
export function proxyWait(host = DB_HOST, port = DB_PORT, seconds = 30): string {
  const tools = ["nc", "python3", "node", "bash"];
  const probe = [
    `command -v nc >/dev/null 2>&1 && nc -z ${host} ${port} >/dev/null 2>&1`,
    `command -v python3 >/dev/null 2>&1 && python3 -c 'import socket,sys;s=socket.socket();s.settimeout(1);sys.exit(s.connect_ex(("${host}",${port})))' >/dev/null 2>&1`,
    `command -v node >/dev/null 2>&1 && node -e 'const s=require("net").connect(${port},"${host}");s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),1000)' >/dev/null 2>&1`,
    `command -v bash >/dev/null 2>&1 && bash -c 'exec 3<>/dev/tcp/${host}/${port}' >/dev/null 2>&1`,
  ].map((c) => `{ ${c}; }`).join(" || ");
  const available = tools.map((t) => `command -v ${t} >/dev/null 2>&1`).join(" || ");
  return `if ${available}; then i=0; while [ $i -lt ${seconds} ]; do if ${probe}; then break; fi; i=$((i+1)); sleep 1; done; fi; `;
}


/**
 * `gcloud run jobs execute` argv. `--wait` blocks until the task finishes and
 * exits non-zero if it failed, which is the signal the caller acts on.
 *
 * The release container is declared first in `releaseJobArgs` and that ordering
 * is load-bearing: a job has no ingress container to identify the main one by,
 * so Cloud Run takes the first, ends the task when it exits and stops the rest.
 * Declared the other way round the task would wait on a Cloud SQL proxy, which
 * never exits on its own, and every release would be "failed" at the task
 * timeout with a successful migration behind it.
 */
export function releaseExecuteArgs(j: Pick<ReleaseJob, "service" | "region" | "project">): string[] {
  return [
    "run", "jobs", "execute", releaseJobName(j.service),
    "--wait", "--region", j.region, "--project", j.project,
  ];
}

/**
 * The release's own output.
 *
 * `gcloud run jobs execute --wait` reports THAT the execution failed and not one
 * line of why — the traceback, the failed statement and the missing environment
 * variable are all in the job's logs. Handing "the release failed" to a user or
 * to the repair agent, with the actual `django.db.utils.ProgrammingError` a
 * command away, is the same defect fetchContainerError was written to close for
 * a crash-looping revision. Newest first, as `gcloud beta run jobs logs read`
 * returns them.
 */
export function releaseLogsArgs(j: Pick<ReleaseJob, "service" | "region" | "project">, limit = 50): string[] {
  return [
    "beta", "run", "jobs", "logs", "read", releaseJobName(j.service),
    "--region", j.region, "--project", j.project,
    `--limit=${limit}`, "--format=value(textPayload)",
  ];
}
