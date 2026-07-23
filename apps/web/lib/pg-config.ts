import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface PgConfig { connectionName: string; user: string; password: string; }

/** Postgres connection config — from env (Secret Manager) on Cloud Run, else the local .pg.json. */
export function pgConfig(): PgConfig {
  if (process.env.PG_PASSWORD) {
    return {
      connectionName: process.env.PG_CONN ?? "supersonic-deploy-prod:us-central1:supersonic-shared-pg",
      user: process.env.PG_USER ?? "postgres",
      password: process.env.PG_PASSWORD,
    };
  }
  const p = join(process.cwd(), ".pg.json");
  if (!existsSync(p)) throw new Error("Postgres config missing (.pg.json locally, or PG_PASSWORD on Cloud Run)");
  return JSON.parse(readFileSync(p, "utf8"));
}

/** True when running on Cloud Run (use the Cloud SQL unix socket instead of the local proxy). */
export function isCloudRun(): boolean {
  return !!process.env.K_SERVICE;
}
