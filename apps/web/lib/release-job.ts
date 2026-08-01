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
 * timeout would replace a diagnosable failure with an undiagnosable one. Written
 * without bash-isms (no /dev/tcp) because it runs inside the customer's own
 * image, whose /bin/sh is usually dash, and it probes for its tools rather than
 * assuming them for the same reason.
 *
 * The runner lane does not use this: services/runner/entrypoint.sh waits for the
 * same port before it execs anything, which covers the runner's release job too
 * because the release job runs that same image through that same entrypoint.
 */
export function proxyWait(host = DB_HOST, port = DB_PORT, seconds = 30): string {
  const probe = [
    `command -v nc >/dev/null 2>&1 && nc -z ${host} ${port} >/dev/null 2>&1`,
    `command -v python3 >/dev/null 2>&1 && python3 -c 'import socket,sys;s=socket.socket();s.settimeout(1);sys.exit(s.connect_ex(("${host}",${port})))' >/dev/null 2>&1`,
    `command -v node >/dev/null 2>&1 && node -e 'const s=require("net").connect(${port},"${host}");s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),1000)' >/dev/null 2>&1`,
  ].map((c) => `{ ${c}; }`).join(" || ");
  return `i=0; while [ $i -lt ${seconds} ]; do if ${probe}; then break; fi; i=$((i+1)); sleep 1; done; `;
}

/**
 * `gcloud run jobs deploy` argv for one service's release.
 *
 * Deliberately NOT `--execute-now --wait`, which would do this and the run in
 * one command. Two commands keep two different failures apart: a job that cannot
 * be CONFIGURED is a platform failure — a missing role, a bad flag, a region
 * that has no such image — and belongs nowhere near the repair agent, which is
 * the same rule IAM_FAILURE already encodes. A job that ran and exited non-zero
 * is the app's migration failing, which is exactly what the repair agent is for.
 * One exit code for both makes every release failure look like the app's fault.
 */
export function releaseJobArgs(j: ReleaseJob): string[] {
  if (j.lane === "static") {
    throw new Error("the static lane has no release phase — a static site has nothing to run before traffic");
  }
  if (!j.release.trim()) throw new Error(`service "${j.service}" has no release command`);
  if (!j.image && !j.source) throw new Error(`lane "${j.lane}" needs an image or a source directory`);

  const timeout = j.taskTimeout ?? RELEASE_TIMEOUT;

  const head = [
    "run", "jobs", "deploy", releaseJobName(j.service),
    "--region", j.region, "--project", j.project, "--format=json",
    // Flags the SERVICE deploy carries that a job rejects outright are absent on
    // purpose: `--allow-unauthenticated` (a job is not served), `--update-labels`
    // (jobs take `--labels`), `--concurrency`, `--cpu-boost` and
    // `--max-instances`. Passing the service's deployFlags through here fails on
    // the first of them with "unrecognized arguments", after the build, for a
    // reason that has nothing to do with the app.
    ...(j.serviceAccount ? [`--service-account=${j.serviceAccount}`] : []),
    ...(j.labels?.length ? [`--labels=${j.labels.join(",")}`] : []),
    // Cloud Run retries a failed task three times by default. A migration that
    // failed half way is not improved by being run again 30 seconds later
    // against the schema it just half-changed, and the retries bury the first
    // failure — the one that says what actually went wrong — under two more.
    // (This is also #35 in the small: a job that retries deploys twice.)
    "--max-retries=0",
    // Exactly once. A release split across parallel tasks would reproduce, with
    // a fresh set of names, the concurrent-migration bug this phase exists to
    // end.
    "--tasks=1", "--parallelism=1",
    `--task-timeout=${timeout}s`,
  ];

  // The runner image fetches the app's bundle and execs $SUPERSONIC_RUN, so the
  // release command travels as env — the image's entrypoint is the thing that
  // knows how to get the code onto disk first, and overriding it would run the
  // migration against an empty /app. Every other lane runs the app's OWN image,
  // whose CMD is the server; there the command has to be overridden, and the
  // proxy wait goes in front of it because that image does not run our
  // entrypoint.
  const runner = j.lane === "runner";
  const env = runner ? withEnv(j.env, "SUPERSONIC_RUN", j.release) : j.env;
  const command = runner
    ? []
    // `--args` is a comma-separated list, so a release command containing a
    // comma — `python manage.py migrate --noinput,` is unusual but
    // `psql -c "SELECT a,b"` is not — would be split into two arguments. The
    // `^~~^` prefix picks a different delimiter for this value only, the same
    // escape the env flags already use.
    : ["--command=/bin/sh", `--args=^~~^-c~~${j.cloudsql ? proxyWait() : ""}${j.release}`];

  return [
    ...head,
    "--container", RELEASE_CONTAINER,
    ...(j.image ? ["--image", j.image] : ["--source", j.source!]),
    // A migration is not a smaller thing than the app. It loads the same
    // framework, the same models and the same settings module, so it needs the
    // same envelope — Cloud Run's 512Mi default OOM-kills a Django release the
    // same way it OOM-kills a Django server.
    "--memory", j.scale.memory, "--cpu", String(j.scale.cpu),
    ...command,
    `--update-env-vars=^~~^${env.join("~~")}`,
    ...(j.secrets ? [`--update-secrets=${j.secrets}`] : []),
    ...(j.cloudsql ? ["--depends-on", "cloudsql-proxy", ...dbContainerArgs(j.cloudsql)] : []),
  ];
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
