import { getPool } from "./db";

const DB = "supersonic_platform";

/** Consumer mail providers — these must never form a shared workspace. */
const PUBLIC_PROVIDERS = new Set([
  "gmail.com", "googlemail.com", "yandex.ru", "yandex.com", "mail.ru",
  "outlook.com", "hotmail.com", "live.com", "icloud.com", "me.com",
  "proton.me", "protonmail.com", "aol.com", "gmx.com", "zoho.com",
  "yahoo.com", "inbox.ru", "bk.ru", "list.ru",
]);

/**
 * The domain an address actually delivers to, or "" if the address is malformed.
 *
 * A valid address has exactly one "@". Reading the *second* field instead would
 * make `boris@luwo.ai@evil.com` look like the luwo.ai domain, while mail really
 * routes to evil.com — enough to pass an allowlist and join someone else's
 * company workspace. Anything that is not exactly local@domain is refused here,
 * and every caller treats "" as "no domain".
 */
export function domainOf(email: string): string {
  const parts = email.trim().toLowerCase().split("@");
  if (parts.length !== 2) return "";
  const [local, domain] = parts;
  if (!local || !domain) return "";
  // A bare "@" or a trailing dot is not a deliverable domain either.
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return "";
  return domain;
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

/**
 * A domain typed by a person, as the value a rule is stored under — or "" when
 * it is not a domain at all.
 *
 * Accepts the three spellings people actually type for the same thing:
 * `@luwo.ai`, `luwo.ai`, and a whole address `boris@luwo.ai`. Everything else
 * is refused rather than repaired, because a rule that silently became a
 * different domain than the one on screen is a rule nobody can audit.
 *
 * The value is what the edge compares a visitor's domain to, with SQL equality.
 * That equality is the point: matching with a suffix test would make a rule for
 * `luwo.ai` also admit `evil-luwo.ai`, which anyone can register — the same
 * mistake `lib/allowlist.ts` carries a comment about.
 */
export function normalizeDomain(input: string): string {
  const raw = input.trim().toLowerCase();
  if (!raw) return "";
  // A whole address is the commonest paste; take the domain half through the
  // same parser that refuses `boris@luwo.ai@evil.com`.
  if (raw.includes("@")) return domainOf(raw.startsWith("@") ? `x${raw}` : raw);
  // 253 is the maximum length of a hostname; a label is 1-63 of [a-z0-9-] and
  // may not start or end with a hyphen. No wildcards: "*" is how the sign-in
  // allowlist spells "everyone", and an app that means everyone is `public`.
  if (raw.length > 253) return "";
  const labels = raw.split(".");
  if (labels.length < 2) return "";
  const label = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  return labels.every((l) => label.test(l)) ? raw : "";
}
