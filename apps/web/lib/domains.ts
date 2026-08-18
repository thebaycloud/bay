/**
 * A domain a person owns, and the rules for letting them point it at an app.
 *
 * Two halves, deliberately in one file: what a hostname is allowed to be (pure,
 * and the part that has to be right), and the four statements the platform makes
 * about one (list, attach, detach, record). The state machine that moves a
 * hostname from "written down" to "serving HTTPS" is not here — it talks to DNS
 * and to Google, and it lives in lib/domain-attach.ts.
 *
 * The platform address is not affected by anything in this file. `<slug>.supersonic.cv`
 * keeps answering for every app whatever domains are attached to it: it is the
 * address the room, the x-ray, the dashboard, the CLI and every share link are
 * built from, and it is the one address whose DNS we control. A custom domain is
 * an additional door, not a replacement one.
 */
import { getPool } from "./db";
import { removeDomainCert } from "./domain-cert";

const DB = "supersonic_platform";

/** The domain we issue addresses under. A person may never attach a name inside it. */
export const ROOT_DOMAIN = "supersonic.cv";

/**
 * How many domains one app may hold.
 *
 * Every attached domain is a Google-managed certificate and an entry in the one
 * certificate map that fronts the whole platform, and that map is a bounded,
 * shared resource: one person adding hostnames in a loop would spend a limit
 * that belongs to everybody. Ten is far above what an app legitimately needs —
 * an apex, a `www`, a couple of marketing names — and far below anything that
 * threatens the map.
 */
export const MAX_DOMAINS_PER_APP = 10;

export type DomainStatus = "pending_dns" | "securing" | "live" | "failed";

export interface AppDomain {
  hostname: string;
  slug: string;
  status: DomainStatus;
  certId: string | null;
  entryId: string | null;
  detail: string | null;
  checkedAt: number | null;
  createdAt: number;
  liveAt: number | null;
}

/**
 * What a person typed, reduced to the hostname it names — or null if it names
 * none.
 *
 * People paste addresses, not hostnames: `https://shop.acme.com/`, `shop.acme.com.`,
 * ` Shop.Acme.com `. All three are the same name and all three have to arrive at
 * the same row, because the primary key on `app_domains` is the whole of our
 * "one hostname, one app" guarantee — two spellings of one name stored twice
 * would let two people each be told they own it.
 *
 * What is deliberately NOT accepted:
 *
 *  - A wildcard (`*.acme.com`). Certificate Manager cannot issue one under
 *    load-balancer authorization at all, so accepting the name would mean
 *    accepting a domain that can never go live.
 *  - A bare label (`localhost`, `com`). Nothing with no dot in it is a name
 *    somebody can own.
 *  - An IP address. It is not a hostname, and TLS on it is not a thing we do.
 *  - A label longer than 63 octets, or a name longer than 253. DNS refuses both,
 *    so the certificate would be refused after the person had already changed
 *    their DNS and started waiting.
 */
export function normalizeHostname(input: string): string | null {
  let s = (input ?? "").trim().toLowerCase();
  if (!s) return null;
  // A pasted URL. Take its hostname and drop everything else, rather than
  // refusing input that unambiguously names one host.
  if (s.includes("://")) {
    try { s = new URL(s).hostname; } catch { return null; }
  }
  // A path, a port, or a query glued to the name — same reasoning as above.
  s = s.split(/[/?#]/)[0];
  s = s.split(":")[0];
  // One trailing dot is the fully-qualified spelling of the same name.
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (!s || s.length > 253) return null;
  if (!s.includes(".")) return null;
  // An IPv4 literal, and the shape of an IPv6 one. Neither is a hostname.
  if (/^\d+(\.\d+)*$/.test(s)) return null;
  if (s.includes("[") || s.includes("]")) return null;
  const labels = s.split(".");
  for (const label of labels) {
    if (!label || label.length > 63) return null;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return null;
  }
  // The last label is the TLD, and a TLD is never numeric — this is what keeps
  // `1.2.3.4.5` and friends out after the pure-digits test above.
  if (/^\d+$/.test(labels[labels.length - 1])) return null;
  return s;
}

/**
 * Why this hostname may not be attached, in words a person can act on — or null
 * when it may.
 *
 * Separate from `normalizeHostname` because these are refusals about WHOSE name
 * it is, not about whether it is a name at all, and the two have different
 * answers for the person: one is a typo, the other is a rule.
 */
export function refuseHostname(hostname: string, rootDomain: string = ROOT_DOMAIN): string | null {
  if (hostname === rootDomain || hostname.endsWith("." + rootDomain)) {
    // Not a technicality. Every app already answers on `<slug>.supersonic.cv`,
    // and a person who attached `other-app.supersonic.cv` to their own app would
    // be claiming a name the platform issues — a row in this table that the
    // edge would have to resolve against the wildcard rule, with one of the two
    // winning for reasons nobody could see from the dashboard.
    return `${rootDomain} addresses are issued by Supersonic — attach a domain you own instead`;
  }
  if (hostname.endsWith(".local") || hostname.endsWith(".localhost") || hostname.endsWith(".internal")) {
    return "that name only exists inside a private network, so it can never get a certificate";
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* The table                                                                  */
/* -------------------------------------------------------------------------- */

interface Row {
  hostname: string;
  slug: string;
  status: DomainStatus;
  cert_id: string | null;
  entry_id: string | null;
  detail: string | null;
  checked_at: Date | null;
  created_at: Date;
  live_at: Date | null;
}

function toDomain(r: Row): AppDomain {
  return {
    hostname: r.hostname,
    slug: r.slug,
    status: r.status,
    certId: r.cert_id,
    entryId: r.entry_id,
    detail: r.detail,
    checkedAt: r.checked_at ? new Date(r.checked_at).getTime() : null,
    createdAt: new Date(r.created_at).getTime(),
    liveAt: r.live_at ? new Date(r.live_at).getTime() : null,
  };
}

/** Every domain attached to one app, oldest first. */
export async function listDomains(slug: string): Promise<AppDomain[]> {
  const r = await getPool(DB).query<Row>(
    `SELECT * FROM app_domains WHERE slug = $1 ORDER BY created_at`,
    [slug]
  );
  return r.rows.map(toDomain);
}

export async function getDomain(hostname: string): Promise<AppDomain | null> {
  const r = await getPool(DB).query<Row>(`SELECT * FROM app_domains WHERE hostname = $1`, [hostname]);
  return r.rows[0] ? toDomain(r.rows[0]) : null;
}

export type AttachResult =
  | { ok: true; domain: AppDomain }
  | { ok: false; taken: true }
  | { ok: false; taken: false; why: string };

/**
 * Write the hostname down against this app.
 *
 * Nothing else happens here — no DNS lookup, no certificate. A person adds a
 * domain BEFORE they change their DNS, because the page they are reading is
 * where the record they have to create is written down; a call that failed
 * until DNS was already correct would be asking them to guess it.
 *
 * Re-attaching a hostname to the app that already has it is not an error and
 * does not reset its state: the dashboard's "add" button is one an impatient
 * person presses twice, and the second press must not throw away a certificate
 * that is halfway issued.
 */
export async function attachDomain(slug: string, hostname: string): Promise<AttachResult> {
  const existing = await getDomain(hostname);
  if (existing) {
    if (existing.slug === slug) return { ok: true, domain: existing };
    // Deliberately not "this domain belongs to app X". Which app claimed a
    // hostname is not a stranger's business, and the one thing the person in
    // front of us can do about it is the same either way.
    return { ok: false, taken: true };
  }
  try {
    const r = await getPool(DB).query<Row>(
      `INSERT INTO app_domains(hostname, slug) VALUES($1, $2) RETURNING *`,
      [hostname, slug]
    );
    return { ok: true, domain: toDomain(r.rows[0]) };
  } catch (e) {
    // The race the read above cannot close: two people adding the same hostname
    // at the same moment. The primary key decides it, and the loser is told the
    // same thing they would have been told a second earlier.
    const code = (e as { code?: string }).code;
    if (code === "23505") return { ok: false, taken: true };
    if (code === "23503") return { ok: false, taken: false, why: "that app does not exist" };
    throw e;
  }
}

/** Forget a hostname. Tearing down its certificate is the caller's job, first. */
export async function detachDomain(hostname: string): Promise<void> {
  await getPool(DB).query(`DELETE FROM app_domains WHERE hostname = $1`, [hostname]);
}

/**
 * Record what the reconcile just learned.
 *
 * `live_at` is set once and never cleared: it is when this domain first
 * answered, which stays true even if the certificate later has to be reissued.
 */
export async function recordDomain(
  hostname: string,
  patch: { status: DomainStatus; detail?: string | null; certId?: string | null; entryId?: string | null }
): Promise<void> {
  await getPool(DB).query(
    `UPDATE app_domains
        SET status = $2,
            detail = $3,
            cert_id = COALESCE($4, cert_id),
            entry_id = COALESCE($5, entry_id),
            checked_at = now(),
            live_at = CASE WHEN $2 = 'live' AND live_at IS NULL THEN now() ELSE live_at END
      WHERE hostname = $1`,
    [hostname, patch.status, patch.detail ?? null, patch.certId ?? null, patch.entryId ?? null]
  );
}

/**
 * Take every domain off an app, load balancer first.
 *
 * Called when the app itself is being deleted. The order is the same one the
 * detach route keeps and for the same reason: the row is what the edge reads to
 * serve the name, so removing it before the certificate would leave a hostname
 * on our load balancer answering a valid TLS handshake with a 404.
 *
 * Returns the hostnames it could not finish, rather than throwing. A delete that
 * fails halfway must still delete the app — a domain left attached to an app
 * that no longer exists is a resource to clean up, and an app that would not
 * delete is a person stuck.
 */
export async function detachAllDomains(slug: string): Promise<string[]> {
  const stuck: string[] = [];
  for (const domain of await listDomains(slug)) {
    const torn = await removeDomainCert(domain.certId, domain.entryId).catch(() => ({ ok: false as const, why: "unreachable" }));
    if (!torn.ok) stuck.push(domain.hostname);
    await detachDomain(domain.hostname);
  }
  return stuck;
}

/**
 * Every domain that has not settled, oldest look first.
 *
 * `live` is excluded because a live domain is done — see `dueForCheck`. The
 * bound is not politeness: this list becomes one DNS query and up to two Google
 * calls per row, on a minute-ly schedule, and an unbounded sweep would turn a
 * hundred abandoned attachments into a permanent load. Rows past the limit are
 * picked up by the next pass, because `checked_at NULLS FIRST` puts the
 * longest-unlooked-at ones in front.
 */
export async function unsettledDomains(limit = 50): Promise<AppDomain[]> {
  const r = await getPool(DB).query<Row>(
    `SELECT * FROM app_domains
      WHERE status <> 'live'
      ORDER BY checked_at ASC NULLS FIRST
      LIMIT $1`,
    [limit]
  );
  return r.rows.map(toDomain);
}
