/**
 * The one place the control plane talks to umami.
 *
 * We run a single umami instance for the whole platform and give each hosted
 * app a "website" row inside it. Thirty-two apps is thirty-two rows, not
 * thirty-two containers — umami's own model is multi-site and there is no
 * reason to pay for a process per tenant to use it.
 *
 * Umami's own interface is never shown to an owner. It exists so we can read
 * numbers back out of the API and draw them ourselves, beside everything else
 * the panel knows. That is why this service has no public ingress: the tracker
 * reaches it through the edge, on the app's own hostname, and nothing else
 * reaches it at all.
 *
 * NOTHING IN HERE MAY FAIL A DEPLOY. Every function returns null on failure and
 * says so in the log. An app with no analytics is an app with no analytics; an
 * app that would not ship because the analytics service was down is a much
 * worse thing, and it is the sort of coupling that only reveals itself at 3am.
 */

import { identityToken } from "./gcp-rest";

const BASE = (process.env.UMAMI_URL ?? "").replace(/\/$/, "");
const USER = process.env.UMAMI_USER ?? "admin";
const PASSWORD = process.env.UMAMI_PASSWORD ?? "";
const ROOT_DOMAIN = process.env.ROOT_DOMAIN ?? "supersonic.cv";

/**
 * The invoker credential, in the header that is NOT `Authorization`.
 *
 * Umami runs `--no-allow-unauthenticated`, so Cloud Run demands a Google ID
 * token before the container sees the request — while umami itself wants its
 * own bearer token in `Authorization`. Cloud Run reads
 * `X-Serverless-Authorization` first when present and leaves `Authorization`
 * alone for the container, which is exactly why that header exists.
 *
 * Empty for a target that is not Cloud Run, which is how this is developed
 * against a local umami in docker. `identityToken` already falls back to
 * `gcloud auth print-identity-token` off the metadata server, so the backfill
 * script works from a laptop against the real service too.
 */
async function invoker(): Promise<Record<string, string>> {
  if (!/(^|\.)run\.app$/.test((() => { try { return new URL(BASE).hostname; } catch { return ""; } })())) return {};
  // An escape hatch for running this from a laptop, and it is not optional
  // there. `identityToken` falls back to `gcloud auth print-identity-token
  // --audiences=<service>`, and gcloud REFUSES that flag for a user account —
  // "Requires valid service account". It returns null, no header is sent, and
  // Cloud Run answers 403 on every call, which reads as a wrong umami password
  // and is nothing of the sort. On Cloud Run the metadata server answers and
  // this variable is never set.
  //
  //   UMAMI_ID_TOKEN=$(gcloud auth print-identity-token) node … db/backfill-umami.ts
  const t = (process.env.UMAMI_ID_TOKEN ?? "").trim() || (await identityToken(new URL(BASE).origin));
  return t ? { "X-Serverless-Authorization": `Bearer ${t}` } : {};
}

/** Configured at all? Absent env is not an error — it is analytics being off. */
export function umamiConfigured(): boolean {
  return Boolean(BASE && PASSWORD);
}

/**
 * Long enough for a service that is asleep to wake up.
 *
 * Umami runs at min-instances 0, so the FIRST call after an idle period pays a
 * container start plus a Prisma connection — comfortably more than the eight
 * seconds this used to allow. That was not an edge case: provisioning happens
 * when somebody deploys an app, which is exactly when nobody has touched
 * analytics recently, so the cold path was the COMMON path and the timeout
 * meant most new apps would silently never get a site.
 *
 * Generous on purpose. Nothing waits on this — it runs inside a deploy that
 * takes minutes, and failing it costs an app its analytics. The proxy's read
 * path keeps its own much shorter timeout, because there a person is waiting
 * and "unreadable" is a better answer than a hang.
 */
const COLD_START_MS = 45_000;

/**
 * The admin token, cached until it is nearly stale.
 *
 * Umami issues a JWT with a long life and no refresh endpoint, so the cheap
 * correct thing is to hold it and log in again when it expires. Re-logging in
 * per call would put an argon2 verification in front of every app creation.
 */
let token: { value: string; until: number } | null = null;
const TOKEN_MS = 6 * 60 * 60 * 1000;

async function authToken(): Promise<string | null> {
  if (token && Date.now() < token.until) return token.value;
  try {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await invoker()) },
      body: JSON.stringify({ username: USER, password: PASSWORD }),
      signal: AbortSignal.timeout(COLD_START_MS),
    });
    if (!r.ok) {
      console.error(`umami: login refused (${r.status})`);
      return null;
    }
    const j = (await r.json()) as { token?: string };
    if (!j.token) return null;
    token = { value: j.token, until: Date.now() + TOKEN_MS };
    return j.token;
  } catch (e) {
    console.error("umami: could not log in —", e instanceof Error ? e.message : e);
    return null;
  }
}

async function api(path: string, init: RequestInit = {}): Promise<Response | null> {
  if (!umamiConfigured()) return null;
  const t = await authToken();
  if (!t) return null;
  try {
    return await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...(await invoker()),
        Authorization: `Bearer ${t}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(COLD_START_MS),
    });
  } catch (e) {
    console.error(`umami: ${path} —`, e instanceof Error ? e.message : e);
    return null;
  }
}

interface Website {
  id: string;
  name: string;
  domain: string;
}

/** Every site umami knows about, or null when it could not be asked. */
export async function listWebsites(): Promise<Website[] | null> {
  const r = await api(`/api/websites?pageSize=500`);
  if (!r || !r.ok) return null;
  const j = (await r.json()) as { data?: Website[] } | Website[];
  return Array.isArray(j) ? j : (j.data ?? null);
}

/**
 * The website id for a slug, creating it if it is not there yet.
 *
 * IDEMPOTENT, and that is the whole reason this looks up before it creates.
 * `createAppRecord` runs on every deploy, not only the first — it reclaims an
 * existing row with ON CONFLICT — so a blind POST here would mint a second site
 * for the same app on the second ship, and the panel would start reading an
 * empty one while the real numbers piled up in a site nothing points at.
 * Umami itself has no unique constraint on domain to stop that.
 */
export async function ensureWebsite(slug: string): Promise<string | null> {
  if (!umamiConfigured()) return null;
  const domain = `${slug}.${ROOT_DOMAIN}`;

  const existing = await listWebsites();
  if (existing === null) return null; // could not ask; do not create a duplicate
  const hit = existing.find((w) => w.domain === domain);
  if (hit) return hit.id;

  const r = await api(`/api/websites`, {
    method: "POST",
    body: JSON.stringify({ name: slug, domain }),
  });
  if (!r || !r.ok) {
    console.error(`umami: could not create a site for ${slug} (${r ? r.status : "unreachable"})`);
    return null;
  }
  const j = (await r.json()) as { id?: string };
  return j.id ?? null;
}

/** Remove an app's site. Best effort — a delete that fails must not fail the delete. */
export async function deleteWebsite(websiteId: string): Promise<void> {
  if (!websiteId) return;
  const r = await api(`/api/websites/${websiteId}`, { method: "DELETE" });
  if (!r || !r.ok) console.error(`umami: could not delete site ${websiteId}`);
}
