import { Pool } from "pg";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Local access to the shared Cloud SQL instance goes through cloud-sql-proxy
// (started on 127.0.0.1:5433). In production the control-plane runs on GCP and
// connects over the Cloud SQL socket instead.
const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 5433;

function pgConfig(): { user: string; password: string } {
  const cfgPath = join(process.cwd(), ".pg.json");
  if (!existsSync(cfgPath)) throw new Error("Postgres config missing (.pg.json) — the shared instance may still be provisioning.");
  return JSON.parse(readFileSync(cfgPath, "utf8"));
}

const pools = new Map<string, Pool>();

export function getPool(dbName: string): Pool {
  const existing = pools.get(dbName);
  if (existing) return existing;
  const { user, password } = pgConfig();
  const pool = new Pool({ host: PROXY_HOST, port: PROXY_PORT, user, password, database: dbName, max: 3, connectionTimeoutMillis: 6000 });
  pools.set(dbName, pool);
  return pool;
}

export function dbNameForSlug(slug: string): string {
  return slug.replace(/-/g, "_").slice(0, 60);
}
