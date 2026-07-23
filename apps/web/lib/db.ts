import { Pool } from "pg";
import { pgConfig, isCloudRun } from "./pg-config";

// Locally: reach the shared Cloud SQL instance through cloud-sql-proxy (127.0.0.1:5433).
// On Cloud Run: connect over the Cloud SQL unix socket (/cloudsql/<connectionName>).
const pools = new Map<string, Pool>();

export function getPool(dbName: string): Pool {
  const existing = pools.get(dbName);
  if (existing) return existing;
  const cfg = pgConfig();
  const pool = isCloudRun()
    ? new Pool({ host: `/cloudsql/${cfg.connectionName}`, user: cfg.user, password: cfg.password, database: dbName, max: 3 })
    : new Pool({ host: "127.0.0.1", port: 5433, user: cfg.user, password: cfg.password, database: dbName, max: 3, connectionTimeoutMillis: 6000 });
  pools.set(dbName, pool);
  return pool;
}

export function dbNameForSlug(slug: string): string {
  return slug.replace(/-/g, "_").slice(0, 60);
}
