import { Pool } from "pg";
import { pgConfig, tenantPgConfig, isCloudRun } from "./pg-config";

/**
 * Pools, keyed by (instance, database).
 *
 * There are TWO Cloud SQL instances and they are not interchangeable: the
 * control plane's own tables are on one, every app's database is on the other.
 * A single pool map keyed by database name alone is what let `dropAppDatabase`
 * run its DROP — and then its verification — against the wrong server and
 * report success. The instance is part of the key because it is part of the
 * identity of a connection.
 *
 * Locally each instance needs its OWN cloud-sql-proxy, because a proxy serves
 * one instance:
 *
 *   cloud-sql-proxy -g --port 5433 …:supersonic-platform-pg   # platform
 *   cloud-sql-proxy -g --port 5434 …:supersonic-shared-pg     # tenants
 *
 * On Cloud Run there are no ports — each instance has its own Unix socket under
 * /cloudsql/<connectionName> — so both must be attached to the service.
 */
const pools = new Map<string, Pool>();

const PLATFORM_PORT = Number(process.env.PG_PORT ?? 5433);
const TENANT_PORT = Number(process.env.TENANT_PG_PORT ?? 5434);

function poolFor(cfg: { connectionName: string; user: string; password: string }, dbName: string, localPort: number): Pool {
  const key = `${cfg.connectionName}/${dbName}`;
  const existing = pools.get(key);
  if (existing) return existing;
  const pool = isCloudRun()
    ? new Pool({ host: `/cloudsql/${cfg.connectionName}`, user: cfg.user, password: cfg.password, database: dbName, max: 3 })
    : new Pool({ host: "127.0.0.1", port: localPort, user: cfg.user, password: cfg.password, database: dbName, max: 3, connectionTimeoutMillis: 6000 });
  pools.set(key, pool);
  return pool;
}

/** A pool on the PLATFORM instance — the control plane's own tables. */
export function getPool(dbName: string): Pool {
  return poolFor(pgConfig(), dbName, PLATFORM_PORT);
}

/**
 * A pool on the TENANT instance — an app's own database.
 *
 * Every caller that names a database belonging to an APP must use this one.
 * There are only three: creating an app's role, dropping an app's database, and
 * the database browser in the dashboard.
 */
export function getTenantPool(dbName: string): Pool {
  return poolFor(tenantPgConfig(), dbName, TENANT_PORT);
}

export function dbNameForSlug(slug: string): string {
  return slug.replace(/-/g, "_").slice(0, 60);
}
