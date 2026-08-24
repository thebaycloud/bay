import { getPool } from "./db";
import { domainOf } from "./workspace";

const DB = "supersonic_platform";

export interface AllowEntry {
  email: string | null;
  domain: string | null;
}

/**
 * May this address sign in at all?
 *
 * Pure: the caller supplies the entries. Deny is the default, and a domain
 * entry matches only a whole domain — comparing with endsWith would let
 * evil-acme.com through.
 */
export function isAllowed(email: string, entries: AllowEntry[]): boolean {
  const addr = email.trim().toLowerCase();
  const domain = domainOf(addr);
  const local = addr.split("@")[0] ?? "";
  if (!addr || !domain || !local) return false;

  for (const e of entries) {
    // A domain of "*" opens sign-in to everyone (signups are public). Remove the
    // wildcard row to re-close the gate.
    if (e.domain && e.domain.trim() === "*") return true;
    if (e.email && e.email.trim().toLowerCase() === addr) return true;
    if (e.domain && e.domain.trim().toLowerCase() === domain) return true;
  }
  return false;
}

async function listAllowEntries(): Promise<AllowEntry[]> {
  const r = await getPool(DB).query(`SELECT email, domain FROM allowed_signins`);
  return r.rows;
}
