import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface PgConfig { connectionName: string; user: string; password: string; }

const PROJECT = "supersonic-deploy-prod";
const REGION = "us-central1";

/**
 * The Cloud SQL instance that holds TENANT databases — one per app.
 *
 * Exported because three other modules had their own copy of this literal
 * (`gcloud.ts`, `backups.ts`, `deploy-pipeline.ts`), and a fourth answer lived
 * in `PG_CONN`. On 12 Aug `PG_CONN` was flipped to the platform's own instance
 * and the three literals were not, so the platform CREATED tenant databases on
 * one server and CONNECTED for them on another. See test/tenant-instance.test.ts
 * for what that cost.
 *
 * One name, one place. `tenantConnectionName()` below is built from it, so the
 * instance we create on and the instance we connect to cannot disagree.
 */
export const TENANT_PG_INSTANCE = "supersonic-shared-pg";

/** The instance holding the control plane's OWN database. */
const PLATFORM_PG_INSTANCE_DEFAULT = "supersonic-platform-pg";

/**
 * Where the control plane's own tables live.
 *
 * `PG_CONN` names THIS one, and naming it is all it does — see
 * `tenantConnectionName`. Before the split it happened to name the tenant
 * instance too, which is why one variable could stand in for both and why
 * nothing broke until they stopped being the same server.
 */
export function platformConnectionName(): string {
  return process.env.PG_CONN ?? `${PROJECT}:${REGION}:${PLATFORM_PG_INSTANCE_DEFAULT}`;
}

/**
 * Where an app's own database lives.
 *
 * Deliberately NOT derived from `PG_CONN`: moving the platform's database must
 * not move anybody's tenant database with it. `TENANT_PG_CONN` exists for the
 * day the tenant instance itself moves, which is its own migration.
 */
export function tenantConnectionName(): string {
  return process.env.TENANT_PG_CONN ?? `${PROJECT}:${REGION}:${TENANT_PG_INSTANCE}`;
}

/** Credentials, which are the same superuser on both instances. */
function credentials(): { user: string; password: string; connectionName?: string } {
  if (process.env.PG_PASSWORD) {
    return { user: process.env.PG_USER ?? "postgres", password: process.env.PG_PASSWORD };
  }
  const p = join(process.cwd(), ".pg.json");
  if (!existsSync(p)) throw new Error("Postgres config missing (.pg.json locally, or PG_PASSWORD on Cloud Run)");
  return JSON.parse(readFileSync(p, "utf8"));
}

/** Connection config for the PLATFORM instance — the control plane's own tables. */
export function pgConfig(): PgConfig {
  const { user, password } = credentials();
  return { connectionName: platformConnectionName(), user, password };
}

/** Connection config for the TENANT instance — the apps' own databases. */
export function tenantPgConfig(): PgConfig {
  const { user, password } = credentials();
  return { connectionName: tenantConnectionName(), user, password };
}

/**
 * True when running on Cloud Run (use the Cloud SQL unix socket instead of the
 * local proxy).
 *
 * `K_SERVICE` alone is not enough: Cloud Run sets it for *services* only, and
 * a **job** gets `CLOUD_RUN_JOB` / `CLOUD_RUN_EXECUTION` instead. With just the
 * service check, the deploy job decided it was a developer's laptop and tried to
 * reach Postgres through cloud-sql-proxy on 127.0.0.1:5433 — it died on
 * ECONNREFUSED before it could read the deploy it was started to run.
 */
export function isCloudRun(): boolean {
  return !!(process.env.K_SERVICE || process.env.CLOUD_RUN_JOB);
}
