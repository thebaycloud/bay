import { randomBytes } from "node:crypto";
import { getPool } from "./db";
import { readAppSecret } from "./app-secrets";

/**
 * A Postgres login of an app's own.
 *
 * Every app used to receive the same credential. `pgConfig()` defaults the user
 * to `postgres` — the cloudsqlsuperuser role — and `databaseEnv()` wrote that one
 * username and password into every app's environment seventeen ways. Postgres
 * grants CONNECT to PUBLIC on a new database by default and nothing revoked it,
 * so any app could reach any other app's database by changing a connection
 * string. Not an exploit: a one-line config change. The Cloud SQL proxy does not
 * help, because roles/cloudsql.client is scoped to the instance, not a database.
 *
 * Worse, `supersonic_platform` is on that same instance through the same
 * pgConfig(), so every customer container could read `users`, `apps`,
 * `deploy_runs` (which holds other customers' .env secrets for the duration of
 * their builds), `deploy_events` and `cli_tokens` — and write to all of them.
 * Nothing stopped `UPDATE apps SET run_url = …`.
 *
 * The codebase reaches the opposite conclusion three times elsewhere, each with a
 * comment saying why: per-bucket grants ("a project-level grant would hand every
 * app the keys to every other app's storage"), a dedicated runtime service
 * account ("arbitrary code we agreed to run"), and per-app AES bundle
 * encryption. Postgres got none of them. This is Postgres getting them.
 *
 * Note what this does NOT fix: a superuser password still exists, and the
 * control plane still shares the instance. Phase 5b of docs/DEPLOY-PLAN.md moves
 * it off. A per-app role is the boundary between tenants; it is not a boundary
 * between a tenant and the platform.
 */

/** The env var the role's password is stored and mounted under. */
export const DB_PASSWORD_SECRET = "SUPERSONIC_DB_PASSWORD";

/**
 * Where `dropAppDatabase` connects FROM.
 *
 * Postgres refuses to drop a database the current session is using, and
 * `getPool` is keyed by database name — so asking it for the target would open
 * precisely the connection that blocks the drop. The platform's own database is
 * on the same instance and is never an app's.
 */
const PLATFORM_DB_FOR_DROP = "supersonic_platform";

export interface AppRole {
  user: string;
  password: string;
  /** False when the role could not be created and the caller must fall back. */
  isolated: boolean;
}

/**
 * Identifiers are interpolated, not bound — Postgres has no parameter slot for a
 * role name — so they are constrained to a shape that cannot carry an injection
 * rather than escaped and hoped over. `dbNameForSlug` already limits the
 * database name to the same alphabet.
 */
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;
/** Hex from randomBytes: [0-9a-f] only, which is safe as a SQL literal by construction. */
const SAFE_PASSWORD = /^[0-9a-f]+$/;

/**
 * Lowercased, because Postgres folds an unquoted identifier to lower case and
 * this name is compared as a STRING against pg_roles.rolname. `CREATE ROLE
 * app_MyApp` stores `app_myapp`, so the existence check would never match its
 * own role: every deploy would try to create it again, and the isolation would
 * quietly degrade to the shared credential it exists to replace.
 *
 * 60 rather than 63 leaves room for the `app_` prefix inside Postgres's
 * identifier limit; a name truncated by Postgres could collide two apps onto one
 * role, which is precisely the failure this module ends.
 */
export function roleNameForSlug(slug: string): string {
  return `app_${slug.toLowerCase().replace(/-/g, "_")}`.slice(0, 60);
}

/**
 * What the app's role is granted, as statements, so the grants can be read and
 * tested without a Postgres.
 *
 * `GRANT ALL ON DATABASE` rather than `GRANT CONNECT`, and the difference is not
 * cosmetic. CONNECT lets the app open the database; CREATE — which ALL includes
 * and CONNECT does not — lets it create schemas and EXTENSIONS. Alembic
 * migrations routinely open with `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`,
 * and under the old shared superuser credential that always worked. The first
 * app to run one as its own role got:
 *
 *   permission denied to create extension "uuid-ossp"
 *   HINT: Must have CREATE privilege on current database
 *
 * which is Phase 5a's bill coming due: taking an app off the superuser account
 * means granting back, explicitly, every power it was silently relying on.
 */
export function grantStatements(role: string, dbName: string): string[] {
  return [
    // The line that closes the hole. Everything else here is about the app still
    // working once its neighbours can no longer connect.
    `REVOKE ALL ON DATABASE ${dbName} FROM PUBLIC`,
    `GRANT ALL ON DATABASE ${dbName} TO ${role}`,
    `GRANT ALL ON SCHEMA public TO ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${role}`,
  ];
}

/**
 * Create (or repair) the app's role, take CONNECT away from everyone else, and
 * hand the app ownership of its own schema.
 *
 * Idempotent, because it runs on every deploy. The password is read back from
 * Secret Manager rather than regenerated: rotating it on each deploy would lock
 * out the revision that is still serving traffic while the new one rolls out.
 *
 * Best-effort by design. A role that cannot be created must not take down a
 * deploy that would otherwise work — it falls back to the shared credential,
 * which is exactly today's behaviour and no worse — but it says so loudly,
 * because "your database is shared" is not something to discover later.
 */
export async function ensureAppRole(
  slug: string,
  dbName: string,
  fallback: { user: string; password: string },
  log: (l: string) => void,
): Promise<AppRole> {
  const role = roleNameForSlug(slug);
  if (!SAFE_IDENT.test(role) || !SAFE_IDENT.test(dbName)) {
    log(`! could not isolate the database: "${role}"/"${dbName}" is not a usable identifier — using the shared credential`);
    return { ...fallback, isolated: false };
  }

  const existing = await readAppSecret(slug, DB_PASSWORD_SECRET);
  const password = existing && SAFE_PASSWORD.test(existing) ? existing : randomBytes(24).toString("hex");

  const pool = getPool(dbName);
  const client = await pool.connect().catch(() => null);
  if (!client) {
    log("! could not reach Postgres to isolate this app's database — using the shared credential");
    return { ...fallback, isolated: false };
  }

  try {
    // CREATE ROLE races with itself when two deploys of the same app overlap, and
    // the loser gets "role already exists" rather than a serializable failure —
    // so the password is set unconditionally afterwards and the create is allowed
    // to lose.
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
          CREATE ROLE ${role} LOGIN PASSWORD '${password}';
        END IF;
      END $$;
    `);
    await client.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${password}'`);

    // Membership in the role we just made.
    //
    // Cloud SQL's `postgres` is NOT a real superuser — it is cloudsqlsuperuser —
    // and Postgres will not let you hand an object to a role you are not a
    // member of. Without this, the first ALTER … OWNER TO fails with
    // `must be able to SET ROLE "app_<slug>"` and takes the whole isolation
    // down with it. Observed on the first real deploy, which is the only place
    // it could have been observed: nothing about it is visible from a unit test,
    // because the rule belongs to the server, not to the SQL.
    await client.query(`GRANT ${role} TO CURRENT_USER`);

    // The lines that close the hole, plus the ones that make the app able to
    // use the database it is now alone in. Allowed to fail only as a whole.
    for (const sql of grantStatements(role, dbName)) await client.query(sql);

    // Ownership of what already exists, best-effort and separately caught.
    //
    // Only matters for a database that has tables from before this existed,
    // where they belong to `postgres` and the app's first migration under its
    // new role would fail with "must be owner of table". A failure here is a
    // migration problem, not a tenancy one — the CONNECT revocation above has
    // already happened — so it must not throw away an isolation that worked.
    try {
      // The app's own database, owned by the app. Belt and braces over the
      // GRANT above — an owner cannot be missing a privilege on its own object,
      // so anything else Alembic reaches for is covered without enumerating it.
      await client.query(`ALTER DATABASE ${dbName} OWNER TO ${role}`);
      await client.query(`ALTER SCHEMA public OWNER TO ${role}`);
      await client.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${role}`);
      await client.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
      await client.query(`
        DO $$
        DECLARE t record;
        BEGIN
          FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
            EXECUTE format('ALTER TABLE public.%I OWNER TO ${role}', t.tablename);
          END LOOP;
          FOR t IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP
            EXECUTE format('ALTER SEQUENCE public.%I OWNER TO ${role}', t.sequencename);
          END LOOP;
        END $$;
      `);
    } catch (e) {
      log(`! this app's database is isolated, but existing tables still belong to the platform role (${e instanceof Error ? e.message.split("\n")[0] : String(e)}) — a migration that ALTERs them may fail`);
    }

    log(`Database isolated — this app connects as ${role} and no other app can reach it`);
    return { user: role, password, isolated: true };
  } catch (e) {
    log(`! could not isolate this app's database (${e instanceof Error ? e.message.split("\n")[0] : String(e)}) — using the shared credential`);
    return { ...fallback, isolated: false };
  } finally {
    client.release();
  }
}

/**
 * The statements that drop an app's database, in order, so the sequence can be
 * read and tested without a Postgres.
 *
 * `gcloud sql databases delete` cannot do this and never could. Provisioning
 * makes the app's own role the OWNER of its database — that is the isolation
 * `ensureAppRole` exists to provide — and gcloud connects as cloudsqlsuperuser,
 * which is not the owner:
 *
 *   ERROR: (gcloud.sql.databases.delete) HTTPError 400: Invalid request:
 *   failed to delete database "icflz". Detail: pq: must be owner of database
 *   icflz.
 *
 * So every delete since databases existed left the customer's data on a shared
 * instance. The fix has to take ownership back before dropping, and each step
 * here is one the server will refuse without the step before it:
 *
 *  1. Membership. Cloud SQL's `postgres` is not a real superuser, so it cannot
 *     take an object from a role it is not a member of — the same rule
 *     `ensureAppRole` hit with `must be able to SET ROLE`.
 *  2. Ownership, which is what gcloud lacked.
 *  3. Disconnect everything else. DROP DATABASE fails outright while any other
 *     session is connected, and a deleted app's containers can still be draining.
 *  4. The drop itself.
 *  5. The role. Left behind it is a live login for an app that no longer exists,
 *     and the slug space is five characters — the name WILL be reissued, and the
 *     new tenant would inherit a stranger's credential. It drops last because a
 *     role cannot be dropped while it owns anything.
 *
 * IF EXISTS throughout: this runs on apps that never had a database at all.
 */
export function dropStatements(role: string, dbName: string): string[] {
  return [
    `GRANT ${role} TO CURRENT_USER`,
    `ALTER DATABASE ${dbName} OWNER TO CURRENT_USER`,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
    `DROP DATABASE IF EXISTS ${dbName}`,
    `DROP ROLE IF EXISTS ${role}`,
  ];
}

/**
 * Drop the app's database and its role.
 *
 * Connected to the PLATFORM database, never to the one being dropped: Postgres
 * refuses to drop a database that the connection itself is using, and `getPool`
 * is keyed by database name, so asking it for the target would open exactly the
 * session that blocks the drop.
 *
 * Every statement is allowed to fail on its own. An app that never had a
 * database, one whose role was never created, one already half-removed by a
 * previous attempt — all of these are ordinary, and none of them should stop the
 * steps that follow. What is NOT tolerated silently is the database still being
 * there afterwards: that is a customer's data left on a shared instance after
 * they asked for it to be gone, and it is reported to the caller.
 */
export async function dropAppDatabase(
  slug: string,
  dbName: string,
  log: (l: string) => void,
): Promise<{ dropped: boolean; reason?: string }> {
  const role = roleNameForSlug(slug);
  if (!SAFE_IDENT.test(role) || !SAFE_IDENT.test(dbName)) {
    return { dropped: false, reason: `"${role}"/"${dbName}" is not a usable identifier` };
  }

  const pool = getPool(PLATFORM_DB_FOR_DROP);
  const client = await pool.connect().catch(() => null);
  if (!client) return { dropped: false, reason: "could not reach Postgres" };

  try {
    for (const sql of dropStatements(role, dbName)) {
      try {
        await client.query(sql);
      } catch (e) {
        // Said, not swallowed. The old code's catch is the reason nobody knew
        // this path had never worked.
        log(`drop ${dbName}: ${sql.split(" ").slice(0, 3).join(" ")} — ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      }
    }

    // Verified, not assumed. Every statement above tolerates failure, so the
    // only honest answer comes from asking the catalogue.
    const { rows } = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
    if (rows.length > 0) return { dropped: false, reason: "still present after the drop" };
    return { dropped: true };
  } finally {
    client.release();
  }
}
