import { getPool } from "./db";

const DB = "supersonic_platform";

/** Consumer mail providers — these must never form a shared workspace. */
const PUBLIC_PROVIDERS = new Set([
  "gmail.com", "googlemail.com", "yandex.ru", "yandex.com", "mail.ru",
  "outlook.com", "hotmail.com", "live.com", "icloud.com", "me.com",
  "proton.me", "protonmail.com", "aol.com", "gmx.com", "zoho.com",
  "yahoo.com", "inbox.ru", "bk.ru", "list.ru",
]);

export function domainOf(email: string): string {
  return email.trim().toLowerCase().split("@")[1] ?? "";
}

export function isPublicEmailProvider(domain: string): boolean {
  return PUBLIC_PROVIDERS.has(domain.trim().toLowerCase());
}

/** Anything that can run a query — a Pool, or a PoolClient inside a transaction. */
interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: { id: string }[] }>;
}

/**
 * Find or create the workspace this email belongs to.
 * Company domains share one workspace; consumer addresses get a personal one.
 *
 * Pass `executor` to run inside a caller's open transaction. Without it this
 * takes its own connection from the pool — which would deadlock if the caller
 * is already holding one, since the pool is small.
 */
export async function resolveWorkspaceForEmail(email: string, executor?: Queryable): Promise<string> {
  const pool: Queryable = executor ?? getPool(DB);
  const domain = domainOf(email);

  if (!domain || isPublicEmailProvider(domain)) {
    const r = await pool.query(
      `INSERT INTO workspaces(domain, kind, name) VALUES(NULL, 'personal', $1) RETURNING id`,
      [email.toLowerCase()]
    );
    return r.rows[0].id;
  }

  const r = await pool.query(
    `INSERT INTO workspaces(domain, kind, name) VALUES($1, 'company', $1)
     ON CONFLICT(domain) DO UPDATE SET domain = EXCLUDED.domain
     RETURNING id`,
    [domain]
  );
  return r.rows[0].id;
}
