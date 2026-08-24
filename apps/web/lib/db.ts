import { Pool, types as pgTypes } from "pg";
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

/**
 * Dates and times, as Postgres spells them.
 *
 * `pg` parses four types into JavaScript `Date` objects, and for three of them
 * that is lossy or wrong:
 *
 *   `date`         2026-08-24 becomes local midnight, which serialises to
 *                  "2026-08-23T19:00:00Z" east of Greenwich. The database
 *                  viewer was showing the WRONG DAY.
 *   `timestamp`    A naive timestamp is read as local time and serialised as
 *                  UTC, so 12:09 was shown as 07:09. Off by the offset.
 *   `timestamptz`  Correct to the millisecond and no further. Postgres keeps
 *                  microseconds, `Date` does not, so a value read and written
 *                  back never equals itself — which is precisely what the row
 *                  editor's compare-and-set asks.
 *
 * Measured, not reasoned: a probe table on the tenant instance returned
 * `2026-08-24 12:09:36.537146+00` as `2026-08-24T12:09:36.537Z`, and
 * `current_date` as the previous evening.
 *
 * So these four come back as TEXT — exactly the characters `::text` would give —
 * and the one screen whose job is telling the truth about data tells it. Anything
 * needing arithmetic can parse the string; nothing in the tenant path does.
 *
 * TENANT POOLS ONLY. The control plane's own code reads `Date` from its own
 * columns and compares them, so the platform pool keeps `pg`'s parsing.
 */
const TEMPORAL_OIDS = [
  1082, // date
  1114, // timestamp without time zone
  1184, // timestamp with time zone
  1266, // timetz
];

const asText = (v: string | null) => v;

function tenantTypes(): { getTypeParser: typeof pgTypes.getTypeParser } {
  return {
    getTypeParser: ((oid: number, format?: unknown) =>
      TEMPORAL_OIDS.includes(oid)
        ? asText
        : (pgTypes.getTypeParser as (o: number, f?: unknown) => unknown)(oid, format)) as typeof pgTypes.getTypeParser,
  };
}

function poolFor(
  cfg: { connectionName: string; user: string; password: string },
  dbName: string,
  localPort: number,
  types?: { getTypeParser: typeof pgTypes.getTypeParser },
  /** The real database, when `dbName` is a key with a suffix on it. */
  database = dbName,
  options?: string,
): Pool {
  const key = `${cfg.connectionName}/${dbName}`;
  const existing = pools.get(key);
  if (existing) return existing;
  const pool = isCloudRun()
    ? new Pool({ host: `/cloudsql/${cfg.connectionName}`, user: cfg.user, password: cfg.password, database, max: 3, types, options })
    : new Pool({ host: "127.0.0.1", port: localPort, user: cfg.user, password: cfg.password, database, max: 3, connectionTimeoutMillis: 6000, types, options });
  // An IDLE client dying is not an exception anybody is awaiting, so `pg` emits
  // it on the pool — and an 'error' event with no listener is how Node ends a
  // process. Measured on 16 Aug against production: dropping an app's database
  // runs `pg_terminate_backend` over it, the control plane still held a pooled
  // connection to that database from the deploy that created it, and the
  // resulting unhandled event took the process down. Nothing was awaiting the
  // dead client, so nothing could catch it.
  //
  // Not specific to the drop, which is why the handler is here and not there:
  // Cloud SQL maintenance restarts every few months and severs every idle
  // connection on the instance. The same crash, on Google's schedule.
  //
  // Logged rather than swallowed. A pool whose clients keep dying is a real
  // condition, and `pg` replaces the client on the next acquire either way.
  pool.on("error", (e) => {
    console.error(`db pool ${key}: idle client error — ${e instanceof Error ? e.message : String(e)}`);
  });
  pools.set(key, pool);
  return pool;
}

/**
 * Forget the pool for a database that is about to stop existing.
 *
 * `DROP DATABASE` fails outright while any session is connected, so the drop
 * path terminates them — including this process's own pooled connections, which
 * it cannot see. Ending the pool first turns a severed connection into a closed
 * one, and drops the entry so a later caller for a REUSED slug does not receive
 * a pool pointed at a database that was deleted underneath it.
 *
 * `end()` is not awaited: the caller is about to drop the database, and a pool
 * that is still finishing its shutdown must not delay that or fail it.
 */
export function forgetTenantPool(dbName: string): void {
  // Both of them. The read-only pool holds connections to the same database, and
  // one left behind is one `DROP DATABASE` cannot proceed past.
  for (const name of [dbName, `${dbName}#ro`]) {
    const key = `${tenantPgConfig().connectionName}/${name}`;
    const pool = pools.get(key);
    if (!pool) continue;
    pools.delete(key);
    pool.end().catch(() => { /* already gone; the point was to stop using it */ });
  }
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
  return poolFor(tenantPgConfig(), dbName, TENANT_PORT, tenantTypes());
}

/**
 * How long any one browsing query may run, and the fact that it cannot write.
 *
 * Both are STARTUP parameters rather than statements, which buys two things.
 *
 * Speed: the browse routes wrapped every read in `BEGIN; SET LOCAL
 * statement_timeout; …; COMMIT`, and a round trip to Cloud SQL through a local
 * proxy measured 196ms — so three of the four round trips in a read were spent
 * arranging the timeout. Set at connection time it costs nothing, and it cannot
 * leak to the next borrower of a pooled connection either, which is what the
 * transaction was for.
 *
 * Safety, which is the better reason: `default_transaction_read_only` means the
 * connection PHYSICALLY CANNOT WRITE. Verified — `UPDATE orders SET status='x'`
 * comes back "cannot execute UPDATE in a read-only transaction". The SELECT-only
 * guard in the route and in the agent's `db` tool stays exactly where it is; this
 * is a second, independent enforcement underneath it, so a hole in a regex is no
 * longer a hole that writes.
 *
 * That matters most for the chat agent. Its read-only tool is the only thing
 * bounding a prompt injected through an app's own rows, and until now that
 * property rested entirely on one `/^select\b/i`.
 */
const READ_ONLY_OPTIONS = [
  `-c statement_timeout=${Number(process.env.TENANT_STATEMENT_TIMEOUT_MS ?? 4000)}`,
  "-c default_transaction_read_only=on",
  // An idle transaction cannot hold a snapshot open forever, whatever a client
  // does with its connection.
  "-c idle_in_transaction_session_timeout=15000",
].join(" ");

/**
 * A pool on the tenant instance that can only read.
 *
 * A DIFFERENT pool from `getTenantPool`, deliberately: `pg-role.ts` creates roles
 * and drops databases over the writable one, and a 4-second cap on a DROP
 * DATABASE would turn a slow tenant into a failed teardown.
 */
export function getTenantReadPool(dbName: string): Pool {
  return poolFor(tenantPgConfig(), `${dbName}#ro`, TENANT_PORT, tenantTypes(), dbName, READ_ONLY_OPTIONS);
}

export function dbNameForSlug(slug: string): string {
  return slug.replace(/-/g, "_").slice(0, 60);
}
