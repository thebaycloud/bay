import { getPool } from "./db";
import { isAllowed, type AllowEntry } from "./allowlist";
import { currentUserId } from "./session";

const DB = "supersonic_platform";

/**
 * Who may read the operators' analytics.
 *
 * This is the sign-in allowlist's mechanism, not a second one: identity comes
 * from `currentUserId()` exactly as every other route gets it, and the decision
 * is `isAllowed` — the same pure matcher, already tested — over rows from a
 * table. Only the table differs, because "may sign in" and "may read everyone
 * else's numbers" are different questions and must be answerable separately.
 *
 * One deliberate difference: the wildcard. `allowed_signins` treats a domain of
 * `*` as "sign-up is open", which is a reasonable thing to want. In an operator
 * table the same row would silently make every user of the product an operator,
 * so wildcards are dropped before matching. Opening admin access has to be
 * something somebody typed an address to do.
 */

/**
 * Admin entries carried in the environment.
 *
 * Exists so the first operator can get in before anyone can write to the
 * database — the table ships empty on purpose. Parsed permissively (commas,
 * whitespace, stray empties) because a config string that half-works is worse
 * than one that does not.
 */
export function envAdminEntries(raw: string | undefined | null): AllowEntry[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s.includes("@"))
    .map((email) => ({ email, domain: null }));
}

/**
 * May this address read the analytics? Pure — the caller supplies the entries.
 *
 * Deny is the default, and a wildcard entry is not an admin grant (see above).
 */
export function isAdmin(email: string, entries: AllowEntry[]): boolean {
  const usable = entries.filter((e) => e.domain?.trim() !== "*");
  return isAllowed(email, usable);
}

/**
 * The admin entries on file: the table plus anything in ADMIN_EMAILS.
 *
 * A missing table reads as no entries rather than an error. The table arrives in
 * a migration, and a control plane that has shipped ahead of it must fail
 * CLOSED — nobody is an admin — rather than 500 on a page that is meant to be
 * unreachable anyway.
 */
async function listAdminEntries(): Promise<AllowEntry[]> {
  const fromEnv = envAdminEntries(process.env.ADMIN_EMAILS);
  try {
    const r = await getPool(DB).query(`SELECT email, domain FROM platform_admins`);
    return [...fromEnv, ...r.rows];
  } catch {
    return fromEnv;
  }
}

/**
 * The signed-in operator's address, or null if the caller is not one.
 *
 * The single gate. Returning the address rather than a boolean means the page
 * can show whose session is reading production numbers, which is the least a
 * page like this owes the person on it.
 *
 * Note that accounts are keyed by (email, provider), so an address on the list
 * grants access to every account holding it — the Google one and the password
 * one alike. That matches what an operator list means: a person, not a login.
 */
export async function currentAdminEmail(): Promise<string | null> {
  const uid = await currentUserId();
  if (!uid) return null;
  let email: string | null = null;
  try {
    const r = await getPool(DB).query(`SELECT email FROM users WHERE id = $1`, [uid]);
    email = r.rows[0]?.email ?? null;
  } catch {
    return null;
  }
  if (!email) return null;
  return isAdmin(email, await listAdminEntries()) ? email : null;
}
