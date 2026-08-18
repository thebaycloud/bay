/**
 * Moving one domain from "written down" to "serving HTTPS", one step per call.
 *
 * There is no queue and no worker behind this. The reconcile runs when somebody
 * asks about the domain — opening the app's settings, pressing Check again — and
 * every step is idempotent, so running it twice is running it once. That is not
 * a shortcut around a job runner: the only thing this loop does is OBSERVE two
 * external facts (what DNS says, what Google says) and write down what it found.
 * Nothing here drives the certificate forward except the first `ensure*` pair;
 * after that Google issues on its own clock whether anyone is watching or not.
 * So a person who closes the tab still gets their certificate — they just do not
 * see the row change to `live` until something looks again.
 *
 * The state a domain is in is therefore always an argument from what was true a
 * moment ago, and `checked_at` is when. A page that says "live" is saying a real
 * request would have been served; it is not saying anybody just tried.
 */
import { promises as dns } from "node:dns";
import type { AppDomain, DomainStatus } from "./domains";
import { recordDomain } from "./domains";
import {
  EDGE_IP,
  certificateState,
  ensureCertificate,
  ensureMapEntry,
  type CertOutcome,
  type CertState,
} from "./domain-cert";

/**
 * How long an answer is trusted before the next look.
 *
 * The dashboard polls while a domain is not live, and every poll would otherwise
 * be a DNS query plus two Google calls per domain. Ten seconds is under what a
 * person reads as "it is not updating" and far above what makes the page a load
 * generator.
 */
export const RECHECK_MS = 10_000;

export interface AttachDeps {
  /** The A records a hostname resolves to. Throws the way `dns.resolve4` throws. */
  resolve4: (hostname: string) => Promise<string[]>;
  ensureCertificate: (hostname: string) => Promise<CertOutcome<string>>;
  ensureMapEntry: (hostname: string, certId: string) => Promise<CertOutcome<string>>;
  certificateState: (certId: string) => Promise<CertOutcome<CertState>>;
  record: (hostname: string, patch: {
    status: DomainStatus; detail?: string | null; certId?: string | null; entryId?: string | null;
  }) => Promise<void>;
  edgeIp: string;
  now: () => number;
}

export const liveAttachDeps: AttachDeps = {
  resolve4: (hostname) => dns.resolve4(hostname),
  ensureCertificate,
  ensureMapEntry,
  certificateState,
  record: recordDomain,
  edgeIp: EDGE_IP,
  now: Date.now,
};

/**
 * Whether this domain is worth looking at again right now.
 *
 * A live domain is never re-checked. Renewal is Google's job and it does not
 * need us; the only events that can end a live domain are the person detaching
 * it, which deletes the row, and the person pointing their DNS somewhere else,
 * which is their decision and not a state we should be quietly rewriting under
 * them. A domain that stopped resolving here would go on saying `live`, and that
 * is the honest reading of what we know: the certificate is still serving, the
 * app is still attached, and traffic is arriving somewhere else because they
 * sent it there.
 */
export function dueForCheck(domain: AppDomain, now: number, recheckMs: number = RECHECK_MS): boolean {
  if (domain.status === "live") return false;
  if (domain.checkedAt === null) return true;
  return now - domain.checkedAt >= recheckMs;
}

export interface Reconciled {
  status: DomainStatus;
  detail: string | null;
  certId?: string | null;
  entryId?: string | null;
}

/**
 * One step, argued from what DNS and Google say right now.
 *
 * The order is forced: the certificate has to exist, then the map entry has to
 * put it on the load balancer, and only then can Google authorize the domain by
 * asking that load balancer for it. See lib/domain-cert.ts.
 */
export async function reconcileDomain(domain: AppDomain, deps: AttachDeps): Promise<Reconciled> {
  const pointsHere = await resolvesToUs(domain.hostname, deps);
  if (!pointsHere.ok) {
    // Not a failure of the domain — a fact about it, and the one the person can
    // fix. Kept in `pending_dns` so the page keeps showing them the record to
    // create rather than an error they cannot act on.
    return { status: "pending_dns", detail: pointsHere.why };
  }

  const cert = await deps.ensureCertificate(domain.hostname);
  if (!cert.ok) return { status: "securing", detail: cert.why };

  const entry = await deps.ensureMapEntry(domain.hostname, cert.value);
  if (!entry.ok) return { status: "securing", detail: entry.why, certId: cert.value };

  const state = await deps.certificateState(cert.value);
  if (!state.ok) return { status: "securing", detail: state.why, certId: cert.value, entryId: entry.value };

  const ids = { certId: cert.value, entryId: entry.value };
  switch (state.value.state) {
    case "active":
      return { status: "live", detail: null, ...ids };
    case "failed":
      return { status: "failed", detail: state.value.detail, ...ids };
    default:
      return { status: "securing", detail: state.value.detail, ...ids };
  }
}

/**
 * Does this name resolve to our load balancer?
 *
 * A records only, and a CNAME needs no special case: `resolve4` follows the
 * chain, so `shop.acme.com CNAME app.supersonic.cv` and `acme.com A 8.233.7.157`
 * both come back as our address. Which of the two records a person created is
 * their business — an apex cannot be a CNAME and a subdomain usually should be.
 *
 * The check is "our address is among the answers", not "our address is the only
 * answer". A name in the middle of a migration legitimately resolves to two
 * places at once, and refusing to proceed until the old one is gone would hold
 * the certificate hostage to the very cutover it is meant to make safe.
 */
async function resolvesToUs(
  hostname: string,
  deps: AttachDeps
): Promise<{ ok: true } | { ok: false; why: string }> {
  let addresses: string[];
  try {
    addresses = await deps.resolve4(hostname);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN") {
      return { ok: false, why: "no DNS record for this name yet" };
    }
    return { ok: false, why: `could not look up DNS for this name (${code ?? "unknown error"})` };
  }
  if (addresses.includes(deps.edgeIp)) return { ok: true };
  if (addresses.length === 0) return { ok: false, why: "no DNS record for this name yet" };
  // Naming the address it points at instead is the whole diagnosis: it is the
  // difference between "DNS has not propagated" and "you pointed it somewhere
  // else", and a person cannot tell those apart from a spinner.
  return { ok: false, why: `points at ${addresses.join(", ")} instead of ${deps.edgeIp}` };
}

/**
 * Look at every domain that is due, and write down what was found.
 *
 * Domains are reconciled together rather than one at a time because the page
 * that asks shows them together: two domains on one app should not be two
 * different ages on the same screen.
 */
export async function reconcileAll(
  domains: AppDomain[],
  deps: AttachDeps = liveAttachDeps
): Promise<AppDomain[]> {
  const now = deps.now();
  return Promise.all(
    domains.map(async (d) => {
      if (!dueForCheck(d, now)) return d;
      const next = await reconcileDomain(d, deps);
      await deps.record(d.hostname, next);
      return {
        ...d,
        status: next.status,
        detail: next.detail,
        certId: next.certId ?? d.certId,
        entryId: next.entryId ?? d.entryId,
        checkedAt: now,
        liveAt: next.status === "live" && d.liveAt === null ? now : d.liveAt,
      };
    })
  );
}
