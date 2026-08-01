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

export const DB_HOST = "127.0.0.1";
export const DB_PORT = "5432";

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
    `--args=--port=${DB_PORT},--address=${DB_HOST},${connectionName}`,
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
  /** The runner images listen on 8080; an app's own image declares its own port. */
  port?: number;
  scale: Scale;
  /** Cloud SQL connection name, or null when the app has no database. */
  cloudsql?: string | null;
  /** Lane-specific container flags, e.g. `--clear-base-image` on the buildpack retry. */
  containerFlags?: string[];
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
  const scoped = d.lane === "runner" || Boolean(d.cloudsql);

  const buildSource = d.image ? ["--image", d.image] : ["--source", d.source!];
  const port = d.port ? ["--port", String(d.port)] : [];
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
