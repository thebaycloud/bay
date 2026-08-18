/**
 * The certificate half of attaching a domain: Certificate Manager, over REST.
 *
 * ## Why this is not gcp-rest.ts
 *
 * Every helper in lib/gcp-rest.ts keeps one contract — "null means I could not
 * do this, run gcloud instead" — because each of them is a fast path in front of
 * a subprocess that already worked. Nothing here has a subprocess behind it.
 * These calls are the only implementation there is, so a failure has to be
 * reportable rather than swallowed: a person waiting for HTTPS on their own
 * domain is owed the reason Google gave, and `null` cannot carry one.
 *
 * ## Load-balancer authorization, and what it costs the person
 *
 * A Google-managed certificate can prove the domain two ways. DNS authorization
 * needs a CNAME under `_acme-challenge` in the customer's zone before anything
 * else happens; load-balancer authorization needs nothing except that the domain
 * already resolves to our load balancer and that the certificate is attached to
 * it through the certificate map.
 *
 * We use the second, which is the one that costs the person a single DNS record
 * instead of two. The price is real and worth stating plainly: a domain that is
 * ALREADY serving somewhere else cannot have its certificate issued before the
 * cutover, so there is a window — minutes, in practice — between their DNS
 * pointing here and HTTPS working here. For a domain that is not yet serving
 * anything, which is nearly all of them, there is no window at all.
 *
 * ## Order matters
 *
 * The map entry has to exist for issuance to succeed: authorization is Google
 * asking our load balancer for this hostname, and the load balancer can only
 * answer for a hostname that is in its certificate map. So it is always
 * certificate, then entry, then wait — never the other way around.
 */
import { createHash } from "node:crypto";
import { accessToken, HTTP_TIMEOUT_MS } from "./gcp-rest";

const PROJECT = process.env.CERT_PROJECT ?? "supersonic-deploy-prod";
/** The map already attached to the HTTPS load balancer that fronts every app. */
const MAP = process.env.CERT_MAP ?? "supersonic-cert-map";
const BASE = `https://certificatemanager.googleapis.com/v1/projects/${PROJECT}/locations/global`;

/** The load balancer every attached domain has to resolve to. */
export const EDGE_IP = process.env.EDGE_IP ?? "8.233.7.157";

export type CertOutcome<T> = { ok: true; value: T } | { ok: false; why: string };

const ok = <T>(value: T): CertOutcome<T> => ({ ok: true, value });
const no = <T>(why: string): CertOutcome<T> => ({ ok: false, why });

/**
 * The resource id for a hostname's certificate and map entry.
 *
 * Deterministic, so creating one twice is the same call twice rather than two
 * certificates for one name — the reconcile runs on every page load and must be
 * safe to run at any moment.
 *
 * The hash is not decoration. Resource ids allow `[a-z0-9-]` up to 63 characters
 * and hostnames allow neither dots nor length limits that small, so the readable
 * part is lossy: `shop.acme.com` and `shop-acme.com` both flatten to
 * `shop-acme-com`, and a truncated 70-character hostname collides with anything
 * sharing its first 40. A collision here would point one person's domain at
 * another person's certificate. The suffix is taken from the full hostname, so
 * two different names cannot produce one id.
 */
export function certIdFor(hostname: string): string {
  const hash = createHash("sha256").update(hostname).digest("hex").slice(0, 10);
  const readable = hostname.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `d-${readable}-${hash}`;
}

async function api(
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<{ status: number; body: any } | null> {
  try {
    const token = await accessToken();
    if (!token) return null;
    const r = await fetch(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    let body: any = null;
    try { body = await r.json(); } catch { /* empty bodies are fine */ }
    return { status: r.status, body };
  } catch {
    return null;
  }
}

/** What Google said went wrong, or a sentence saying we could not find out. */
function why(r: { status: number; body: any } | null, doing: string): string {
  if (!r) return `could not reach Certificate Manager while ${doing}`;
  const message = r.body?.error?.message;
  return message ? `${doing}: ${message}` : `${doing}: Certificate Manager answered ${r.status}`;
}

/**
 * The certificate for this hostname, created if it is not there.
 *
 * ALREADY_EXISTS is success. This runs again on every reconcile, and the second
 * run must be the same answer as the first rather than an error a person reads.
 */
export async function ensureCertificate(hostname: string): Promise<CertOutcome<string>> {
  const id = certIdFor(hostname);
  const existing = await api(`/certificates/${id}`);
  if (existing && existing.status === 200) return ok(id);

  const created = await api(`/certificates?certificateId=${id}`, {
    method: "POST",
    // No `dnsAuthorizations` and no `issuanceConfig` — that absence IS the
    // request for load-balancer authorization. See this file's header.
    body: { managed: { domains: [hostname] }, description: `supersonic custom domain ${hostname}` },
  });
  if (created && (created.status === 200 || created.status === 409)) return ok(id);
  return no(why(created, "creating the certificate"));
}

/**
 * The certificate map entry that puts this hostname on the load balancer.
 *
 * Until this exists the load balancer has no certificate to offer for the name,
 * which is why issuance cannot complete without it.
 */
export async function ensureMapEntry(hostname: string, certId: string): Promise<CertOutcome<string>> {
  const id = certIdFor(hostname);
  const existing = await api(`/certificateMaps/${MAP}/certificateMapEntries/${id}`);
  if (existing && existing.status === 200) return ok(id);

  const created = await api(`/certificateMaps/${MAP}/certificateMapEntries?certificateMapEntryId=${id}`, {
    method: "POST",
    body: {
      hostname,
      certificates: [`projects/${PROJECT}/locations/global/certificates/${certId}`],
    },
  });
  if (created && (created.status === 200 || created.status === 409)) return ok(id);
  return no(why(created, "putting the domain on the load balancer"));
}

export type CertState =
  | { state: "provisioning"; detail: string | null }
  | { state: "active" }
  | { state: "failed"; detail: string };

/**
 * Where issuance has got to.
 *
 * `authorizationAttemptInfo` is read as well as `state`, and it is the more
 * useful of the two: a certificate sits in PROVISIONING both while Google has
 * not looked yet and while it has looked and failed to reach the domain, and
 * only the attempt info separates them. Telling a person "still working on it"
 * for an hour, when what actually happened is that their DNS record points
 * somewhere else, is the failure this reads around.
 */
export function readCertState(body: any): CertState {
  const managed = body?.managed ?? {};
  const attempt = Array.isArray(managed.authorizationAttemptInfo) ? managed.authorizationAttemptInfo[0] : null;
  if (managed.state === "ACTIVE") return { state: "active" };
  if (managed.state === "FAILED") {
    return {
      state: "failed",
      detail:
        managed.provisioningIssue?.details ||
        attempt?.details ||
        attempt?.failureReason ||
        "Google refused to issue the certificate",
    };
  }
  const stalled = attempt && attempt.state === "FAILED";
  return {
    state: "provisioning",
    detail: stalled
      ? attempt.details || attempt.failureReason || null
      : managed.provisioningIssue?.details ?? null,
  };
}

export async function certificateState(certId: string): Promise<CertOutcome<CertState>> {
  const r = await api(`/certificates/${certId}`);
  if (!r || r.status !== 200) return no(why(r, "checking the certificate"));
  return ok(readCertState(r.body));
}

/**
 * Take the hostname off the load balancer and delete its certificate.
 *
 * The entry goes first and its deletion is waited on: a certificate still
 * referenced by an entry cannot be deleted, and deleting the certificate while
 * the entry lived would leave the load balancer holding a name it cannot serve.
 *
 * A certificate that survives is reported and not retried. By then the hostname
 * is already off the load balancer, which is the part that decides what the
 * internet sees; what is left is a resource with no traffic behind it.
 */
export async function removeDomainCert(certId: string | null, entryId: string | null): Promise<CertOutcome<null>> {
  if (entryId) {
    const del = await api(`/certificateMaps/${MAP}/certificateMapEntries/${entryId}`, { method: "DELETE" });
    if (!del || (del.status !== 200 && del.status !== 404)) {
      return no(why(del, "taking the domain off the load balancer"));
    }
    if (del.status === 200 && typeof del.body?.name === "string") await waitOperation(del.body.name);
  }
  if (certId) {
    const del = await api(`/certificates/${certId}`, { method: "DELETE" });
    if (!del || (del.status !== 200 && del.status !== 404)) {
      return no(why(del, "deleting the certificate"));
    }
  }
  return ok(null);
}

/** The last segment of an operation resource name — `.../operations/x` → `x`. */
export function operationId(name: string): string {
  return name.split("/").filter(Boolean).pop() ?? "";
}

/**
 * Wait for one long-running operation, briefly.
 *
 * Bounded on purpose: this is called on a request a person is waiting on, and
 * the only thing that depends on the wait is whether the certificate delete on
 * the next line succeeds or has to be left to a later detach. Ten seconds is
 * long enough for an entry deletion, which is the only operation waited on here.
 */
async function waitOperation(name: string, budgetMs = 10_000): Promise<void> {
  const id = operationId(name);
  if (!id) return;
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    const r = await api(`/operations/${id}`);
    if (!r || r.status !== 200) return;
    if (r.body?.done) return;
    await new Promise((res) => setTimeout(res, 500));
  }
}
