/**
 * One place that turns "deploy this service" into a `gcloud run deploy` argv.
 *
 * Before this module, four lanes each assembled their own argv inline and only
 * ONE of them — the runner — appended `appFlags`, the flags carrying
 * `--update-env-vars` and `--update-secrets`. So an app on the Dockerfile or
 * buildpack lane deployed with an EMPTY environment and no network path to the
 * database the pipeline had just provisioned for it: no DATABASE_URL, no
 * secrets, no Cloud SQL proxy beside it, on Cloud Run's default 512 MiB. A
 * perfectly-configured Rust or Java API was undeployable for reasons that
 * appeared nowhere in its own logs.
 *
 * The bug was not any one missing line. It was that "apply the plan" existed
 * four times, so adding a field meant finding four readers and nothing failed
 * when you missed one. This module is the single reader. Adding a flag here
 * reaches every lane at once, and `test/lanes.test.ts` loops over the lane list
 * so a fifth lane cannot be added without showing up in the assertions.
 */

/** Which strategy builds and runs a service. Derived by the resolver, never authored. */
export type Lane = "static" | "runner" | "container" | "buildpack";

/** The lanes that produce a Cloud Run service. `static` publishes to GCS instead. */
export const SERVICE_LANES: Lane[] = ["runner", "container", "buildpack"];

/**
 * Cloud Run's own default container port, and therefore the one an app already
 * gets when nothing says otherwise. Named here because the scoped argv has to
 * state it explicitly and must not state anything else.
 */
export const DEFAULT_PORT = 8080;

export const DB_HOST = "127.0.0.1";
export const DB_PORT = "5432";
/**
 * Where the proxy answers health checks, as opposed to database traffic.
 *
 * A separate port because it is the only thing bound beyond loopback — Cloud
 * Run's prober has to reach it, and the database port must stay unreachable.
 */
export const DB_HEALTH_PORT = "9801";

const CLOUD_SQL_PROXY_IMAGE = process.env.CLOUD_SQL_PROXY_IMAGE
  ?? "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.14.1";

/**
 * Every spelling of the same database endpoint.
 *
 * `DATABASE_URL` alone is not enough: plenty of apps never read it and require
 * POSTGRES_SERVER or PGHOST. `POSTGRES_*` is what docker-compose-shaped projects
 * use (the FastAPI template requires POSTGRES_SERVER and reads no URL at all);
 * `PG*` are libpq's own variables, honoured by psql, psycopg and node-postgres
 * with no code at all; `DB_*` is the Laravel and older-Django spelling. They all
 * describe the identical endpoint, so setting all of them cannot make one app
 * disagree with another.
 *
 * This list is also the SOURCE of the protected-name set (`PLATFORM_OWNED`): a
 * name the platform writes is a name a user may not declare. Deriving one from
 * the other is the point — the two lists drifted apart once already, 6 names
 * against 17, and every name missing from the shorter one was a user value the
 * platform silently overwrote.
 */
export function databaseEnv(db: { databaseUrl: string; user: string; password: string; dbName: string }): string[] {
  return [
    `DATABASE_URL=${db.databaseUrl}`,
    `POSTGRES_SERVER=${DB_HOST}`, `POSTGRES_HOST=${DB_HOST}`, `POSTGRES_PORT=${DB_PORT}`,
    `POSTGRES_USER=${db.user}`, `POSTGRES_PASSWORD=${db.password}`, `POSTGRES_DB=${db.dbName}`,
    `PGHOST=${DB_HOST}`, `PGPORT=${DB_PORT}`,
    `PGUSER=${db.user}`, `PGPASSWORD=${db.password}`, `PGDATABASE=${db.dbName}`,
    `DB_HOST=${DB_HOST}`, `DB_PORT=${DB_PORT}`,
    `DB_USER=${db.user}`, `DB_PASSWORD=${db.password}`, `DB_NAME=${db.dbName}`,
  ];
}

/** The names `databaseEnv()` writes, without values. Derived, so it cannot drift. */
export function databaseEnvNames(): string[] {
  return databaseEnv({ databaseUrl: "", user: "", password: "", dbName: "" })
    .map((pair) => pair.slice(0, pair.indexOf("=")));
}

/**
 * The proxy container, appended after the app's own container flags.
 *
 * `--depends-on` makes Cloud Run start it first, so the app is not racing a port
 * that is not listening yet. The proxy authenticates as the service's own
 * identity, which therefore needs roles/cloudsql.client.
 */
export function dbContainerArgs(connectionName: string): string[] {
  return [
    "--container", "cloudsql-proxy",
    "--image", CLOUD_SQL_PROXY_IMAGE,
    // `--args=…` as ONE token. Passed as two, gcloud reads the value's leading
    // `--port=` as a flag of its own and refuses with "expected one argument".
    // Identical to the mistake already fixed in startDeployJob — the value
    // beginning with a dash is what makes it look like a flag, and the fix is
    // never to let it be a separate argv entry.
    // The database port stays on loopback; the HEALTH port is what Cloud Run is
    // allowed to reach. See the probe below for why they cannot be the same one.
    `--args=--port=${DB_PORT},--address=${DB_HOST},--health-check,--http-address=0.0.0.0,--http-port=${DB_HEALTH_PORT},${connectionName}`,
    // Required, not optional. Cloud Run refuses any revision whose `--depends-on`
    // names a container without one:
    //
    //   spec.template.spec.containers[0].depends_on: Dependent container
    //   'cloudsql-proxy' must have startup probe specified
    //
    // Which means no app with a database had ever deployed on a lane that
    // attaches this sidecar — the flag pair was written, the revision was
    // rejected, and the failure went to a repair agent that correctly reported
    // it could not fix the platform from inside the repository.
    //
    // NOT a TCP probe on 5432, which was the obvious first answer and is wrong.
    // The proxy binds the database port to 127.0.0.1 deliberately, and Cloud
    // Run's prober connects to the container's address rather than its loopback,
    // so it cannot see a loopback-only listener. The proxy logs "ready for new
    // connections" and the probe fails 30 times against the same port:
    //
    //   STARTUP TCP probe failed 30 times consecutively ... DEADLINE_EXCEEDED
    //
    // Binding 5432 to 0.0.0.0 would satisfy the probe by widening what listens
    // for the database — the wrong half to move. The proxy's own health server
    // is the right one: it answers /startup only once the instance is genuinely
    // ready, and it is the only thing exposed beyond loopback.
    //
    // periodSeconds > timeoutSeconds is enforced by Cloud Run, which rejects the
    // revision outright rather than clamping:
    //   startup_probe.timeout_seconds: must be less than period_seconds
    // 3s apart, 20 attempts, so the proxy has a full minute to authorise against
    // Cloud SQL before the instance is called dead.
    `--startup-probe=httpGet.path=/startup,httpGet.port=${DB_HEALTH_PORT},periodSeconds=3,timeoutSeconds=2,failureThreshold=20`,
  ];
}

/**
 * What the service is allowed to consume. Only the runner lane set any of this
 * before; every other lane inherited Cloud Run's defaults, and the default that
 * mattered was 512 MiB — measured to OOM-kill a real Node app at 564 MiB before
 * it ever binds $PORT, and nowhere near a JVM's floor. The failure reads as a
 * flaky "didn't start on $PORT", which is the least useful thing it could say.
 */
export interface Scale {
  memory: string;
  cpu: number;
  /** Unbounded by default in Cloud Run, which is an unbounded bill. */
  maxInstances: number;
  /** Seconds. Cloud Run's 300s default kills any long export or report. */
  timeout: number;
  concurrency: number;
  cpuBoost: boolean;
}

export const DEFAULT_SCALE: Scale = {
  memory: process.env.RUNNER_MEMORY || "2Gi",
  cpu: 1,
  maxInstances: 10,
  timeout: 900,
  concurrency: 80,
  cpuBoost: true,
};

/** Merge a partial, user-declared scale over the defaults. */
export function withScale(over?: Partial<Scale> | null): Scale {
  return { ...DEFAULT_SCALE, ...(over ?? {}) };
}

/** Scale flags that belong to the SERVICE, not to a container. */
function scaleServiceFlags(scale: Scale): string[] {
  return [
    `--max-instances=${scale.maxInstances}`,
    `--timeout=${scale.timeout}`,
    `--concurrency=${scale.concurrency}`,
    scale.cpuBoost ? "--cpu-boost" : "--no-cpu-boost",
  ];
}

/** Scale flags that belong to a CONTAINER (and work unscoped when there is one). */
function scaleContainerFlags(scale: Scale): string[] {
  return ["--memory", scale.memory, "--cpu", String(scale.cpu)];
}

export interface LaneDeploy {
  lane: Lane;
  /** The Cloud Run service name. */
  service: string;
  /** region, project, auth, format, labels, service account — always service-level. */
  serviceFlags: string[];
  /** `--update-env-vars` / `--update-secrets`. Container-scoped when a sidecar exists. */
  appFlags: string[];
  /** runner + container lanes. */
  image?: string;
  /** buildpack lane: the directory Cloud Run builds from. */
  source?: string;
  /**
   * The port the ingress container listens on. Defaults to Cloud Run's own 8080,
   * which is what a service with no `--port` gets anyway.
   */
  port?: number;
  scale: Scale;
  /** Cloud SQL connection name, or null when the app has no database. */
  cloudsql?: string | null;
  /** Lane-specific container flags, e.g. `--clear-base-image` on the buildpack retry. */
  containerFlags?: string[];
  /**
   * Whether the service ALREADY deployed carries named containers, or null when
   * there is no service yet.
   *
   * The shape is a property of the live service, not of the lane that is about to
   * deploy — and reading it off the lane was wrong for the one case nobody had
   * tried: a service that CHANGES lane. hl52l was created by the buildpack lane
   * (one unnamed container) and moved to the runner lane the moment it gained a
   * `supersonic.json` saying `language: "python"`. The runner lane always names
   * its container, gcloud added `app` BESIDE the unnamed one instead of renaming
   * it, and two containers ended up with an exposed port:
   *
   *   spec.template.spec.containers: Revision template should contain exactly one
   *   container with an exposed port.
   *
   * A nine-minute build, a successful release job, and then a rejection at the
   * last command — for a transition the comment below already described and the
   * code asked the wrong object about.
   */
  existingScoped?: boolean | null;
}

/**
 * Build the argv for one service deploy.
 *
 * Two shapes. Cloud Run requires `--container NAME` once more than one container
 * is involved, and only service-level flags may appear before the first
 * `--container` — so a sidecar forces the scoped shape. Without one, the flat
 * shape is what a single-container service has always accepted.
 *
 * Which shape a service gets is NOT a free choice, because it is not idempotent:
 * naming the container of a service last deployed with an unnamed one — or
 * un-naming one that was named — rewrites the container set of a live service.
 * So the rule is "whatever this lane already did", plus the sidecar:
 *
 *   runner   → always scoped. It has deployed `--container app` from the start.
 *   container/buildpack → flat, unless the app has a database. Those lanes have
 *     always deployed a single unnamed container; an app that now reaches the
 *     scoped shape is an app that could not work at all before, because it is
 *     one with a database and those lanes never attached the proxy.
 *
 * A parity fix should not smuggle in a migration for services that were working.
 */
export function deployArgs(d: LaneDeploy): string[] {
  if (d.lane === "static") {
    throw new Error("the static lane publishes to GCS and deploys no Cloud Run service");
  }
  if (!d.image && !d.source) {
    throw new Error(`lane "${d.lane}" needs an image or a source directory`);
  }
  // A sidecar leaves no choice — Cloud Run requires the scoped shape once more
  // than one container is involved, so an app with a proxy beside it must migrate
  // whatever it looked like before. Otherwise the LIVE service decides, because
  // the shape belongs to it: a service already carrying named containers keeps
  // them, one carrying an unnamed container keeps that, and only a service that
  // does not exist yet takes the lane's default. That is the difference between
  // "whatever this lane already did" — true only while a service never changes
  // lane — and "whatever this service already did", which survives a repo gaining
  // a `supersonic.json` that moves it from buildpack to runner.
  const scoped = Boolean(d.cloudsql) || (d.existingScoped ?? d.lane === "runner");

  const buildSource = d.image ? ["--image", d.image] : ["--source", d.source!];
  // A multi-container service has no other way to say which container answers
  // requests, so Cloud Run makes the port the marker and gcloud refuses the
  // whole revision without one:
  //
  //   ERROR: (gcloud.run.deploy) Invalid value for [--container]:
  //   Exactly one container must specify --port or --use-http2
  //
  // Which is what a container-lane app WITH a database got, every time, from the
  // moment Phase 0 gave that combination the sidecar it had been missing. The
  // parity fix moved it from "deploys with an empty environment" to "does not
  // deploy at all", and nothing caught it because the assertions asked what the
  // argv contained and never what gcloud would do with it.
  //
  // 8080 rather than anything discovered from the image: it is Cloud Run's own
  // default, so this is the port the same app already gets on the flat shape.
  // The invariant that matters is that attaching a sidecar does not move the
  // app's port — a container that only ever bound $PORT is told 8080 either way.
  const ingressPort = d.port ?? (scoped ? DEFAULT_PORT : null);
  const port = ingressPort === null ? [] : ["--port", String(ingressPort)];
  const container = [
    ...buildSource,
    ...port,
    ...scaleContainerFlags(d.scale),
    ...d.appFlags,
    ...(d.containerFlags ?? []),
  ];

  const head = ["run", "deploy", d.service, ...d.serviceFlags, ...scaleServiceFlags(d.scale)];

  if (!scoped) return [...head, ...container];

  return [
    ...head,
    "--container", "app",
    ...container,
    ...(d.cloudsql ? ["--depends-on", "cloudsql-proxy", ...dbContainerArgs(d.cloudsql)] : []),
  ];
}
