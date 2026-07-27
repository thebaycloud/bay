import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

interface PgConfig {
  connectionName: string;
  user: string;
  password: string;
}

/** Postgres config — from env (Secret Manager) on Cloud Run, else the local .pg.json. */
function pgConfig(): PgConfig {
  // Callers that already have a connection string never reach here.
  if (process.env.PG_PASSWORD) {
    return {
      connectionName:
        process.env.PG_CONN ?? "supersonic-deploy-prod:us-central1:supersonic-shared-pg",
      user: process.env.PG_USER ?? "postgres",
      password: process.env.PG_PASSWORD,
    };
  }
  const p = join(process.cwd(), ".pg.json");
  if (!existsSync(p)) {
    throw new Error("Postgres config missing (.pg.json locally, or PG_PASSWORD on Cloud Run)");
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

function isCloudRun(): boolean {
  return !!process.env.K_SERVICE;
}

const DB_NAME = process.env.OUTREACH_DB ?? "supersonic_outreach";

let pool: Pool | undefined;

/**
 * With DATABASE_URL: use it verbatim. This is the escape hatch for a plain
 * local Postgres — an internal growth tool does not need the shared production
 * instance, and requiring cloud-sql-proxy to run before you can create one
 * account is friction with no upside.
 *
 * Otherwise, locally: reach the shared Cloud SQL instance through
 * cloud-sql-proxy (127.0.0.1:5433). On Cloud Run: the Cloud SQL unix socket.
 */
export function getPool(): Pool {
  if (pool) return pool;

  if (process.env.DATABASE_URL) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
    return pool;
  }

  const cfg = pgConfig();
  pool = isCloudRun()
    ? new Pool({
        host: `/cloudsql/${cfg.connectionName}`,
        user: cfg.user,
        password: cfg.password,
        database: DB_NAME,
        max: 3,
      })
    : new Pool({
        host: "127.0.0.1",
        port: 5433,
        user: cfg.user,
        password: cfg.password,
        database: DB_NAME,
        max: 3,
        connectionTimeoutMillis: 6000,
      });
  return pool;
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
