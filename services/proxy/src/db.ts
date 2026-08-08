import { Pool } from "pg";

/**
 * The proxy's one connection pool.
 *
 * Lived inside registry.ts until the room needed to read the deploy's event log
 * too. Two modules opening two pools against the same instance would double the
 * connection count for no reason — the proxy runs at min-instances=1 and the
 * shared Postgres is the scarce thing here, not the process.
 */
let pool: Pool | null = null;

export function db(): Pool {
  if (pool) return pool;
  const connectionName = process.env.PG_CONN ?? "supersonic-deploy-prod:us-central1:supersonic-shared-pg";
  pool = process.env.K_SERVICE
    ? new Pool({ host: `/cloudsql/${connectionName}`, user: process.env.PG_USER ?? "postgres", password: process.env.PG_PASSWORD, database: "supersonic_platform", max: 5 })
    : new Pool({ host: "127.0.0.1", port: 5433, user: process.env.PG_USER ?? "postgres", password: process.env.PG_PASSWORD, database: "supersonic_platform", max: 5 });
  return pool;
}
