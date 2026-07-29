/**
 * Google Cloud over REST, for the calls that sit on the deploy hot path.
 *
 * Every one of these has a working `gcloud` implementation already. The only
 * reason this file exists is speed: a `gcloud` invocation is a Python
 * interpreter start (~0.4s bare, ~2.5s once the storage client stack is
 * imported), which is pure overhead on top of a single HTTP request.
 *
 * The contract every helper here keeps, without exception:
 *
 *   **null means "I could not do this — use gcloud".**
 *
 * Nothing in here throws, and nothing in here is allowed to become a new way
 * for a deploy to fail. A non-2xx, a timeout, a shape we did not expect, an
 * unreachable metadata server: all of it collapses to `null`, and the caller
 * runs exactly the subprocess it ran before. The worst case of a bug in this
 * file is that a deploy is as slow as it used to be.
 */
import { spawn } from "node:child_process";

const PROJECT = "supersonic-deploy-prod";
const REGION = "us-central1";

const ENV = {
  ...process.env,
  PATH: `/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH ?? ""}`,
  CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
} as NodeJS.ProcessEnv;

/** How long a single REST call may take before we give up and let gcloud try. */
const HTTP_TIMEOUT_MS = 20_000;
/** The metadata server is on-host; if it does not answer instantly it is absent. */
const METADATA_TIMEOUT_MS = 1_000;
/**
 * How long "the metadata server did not answer" is believed before probing
 * again. Without this, one transient blip on Cloud Run would pin the process to
 * gcloud spawns forever. Locally the probe only runs on a cache miss (every
 * GCLOUD_TOKEN_TTL_MS at most), so re-probing costs almost nothing.
 */
const METADATA_RETRY_MS = 5 * 60_000;
/** Refresh a token this long before it actually expires. */
const TOKEN_SKEW_MS = 5 * 60_000;
/**
 * `gcloud auth print-access-token` reports no expiry, so a token from that path
 * is trusted for a short fixed window rather than a guessed one.
 *
 * 4 minutes, and the number is not arbitrary: gcloud refreshes a credential only
 * when it has less than `_CREDENTIALS_EXPIRY_WINDOW = '300s'` of life left
 * (googlecloudsdk/core/credentials/store.py — `Load` → `RefreshIfAlmostExpire` →
 * `RefreshIfExpireWithinWindow`). So the *only* guarantee the command gives is
 * "at least 300 seconds". Caching for longer than that — 10 minutes, as this did
 * — means up to five minutes of the window hands out a token that is already
 * dead. Staying under 300s makes every cached token provably live. Re-spawning
 * gcloud every 4 minutes is cheap; serving a dead token is not.
 */
const GCLOUD_TOKEN_TTL_MS = 4 * 60_000;
/** 50 pages × 1000 objects. Past that, hand the listing back to gcloud. */
const MAX_LIST_PAGES = 50;

/* -------------------------------------------------------------------------- */
/* Pure helpers — URL building, response shaping, expiry arithmetic.           */
/* These are the parts worth unit-testing, so they take no I/O and no clock.   */
/* -------------------------------------------------------------------------- */

export interface TokenEntry {
  token: string;
  /** Epoch ms after which this token must not be used. */
  expiresAt: number;
}

/**
 * When a token acquired now, with `expiresInSeconds` of life, stops being
 * usable. Always earlier than the real expiry so an in-flight request cannot
 * straddle the boundary. A token that is already too short-lived to be worth
 * caching lands in the past, which `tokenUsable` then rejects.
 */
export function tokenExpiresAt(expiresInSeconds: number, now: number, skewMs: number = TOKEN_SKEW_MS): number {
  const life = Number.isFinite(expiresInSeconds) ? expiresInSeconds : 0;
  return now + Math.max(0, life) * 1000 - skewMs;
}

export function tokenUsable(entry: TokenEntry | null, now: number): boolean {
  return Boolean(entry && entry.token && now < entry.expiresAt);
}

/** The outcome of the last metadata-server probe, and when it happened. */
export interface MetadataProbe {
  ok: boolean;
  /** Epoch ms of the probe. */
  at: number;
}

/**
 * Whether to ask the metadata server again.
 *
 * A previous success is always re-asked: we are there to mint a fresh token, and
 * only reach this point when the cached one has run out. A previous *failure* is
 * believed for `retryMs` and then re-probed — sticky-forever would mean one
 * transient blip on Cloud Run costs the process its fast token path for good,
 * and never-sticky would mean local dev pays the probe timeout every time.
 */
export function shouldProbeMetadata(probe: MetadataProbe | null, now: number, retryMs: number = METADATA_RETRY_MS): boolean {
  if (!probe) return true;
  if (probe.ok) return true;
  return now - probe.at >= retryMs;
}

/** GCS object names go in a URL *path* segment: `/` must survive as `%2F`. */
export function encodeObjectName(name: string): string {
  return encodeURIComponent(name);
}

export function objectsListUrl(bucket: string, prefix: string, pageToken?: string): string {
  const q = new URLSearchParams({
    prefix,
    maxResults: "1000",
    fields: "items(name),nextPageToken",
  });
  if (pageToken) q.set("pageToken", pageToken);
  return `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o?${q.toString()}`;
}

export function objectMediaUrl(bucket: string, name: string): string {
  return `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeObjectName(name)}?alt=media`;
}

export function objectInsertUrl(bucket: string, name: string): string {
  const q = new URLSearchParams({ uploadType: "media", name });
  return `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?${q.toString()}`;
}

/**
 * Cloud Run Admin API v1 (`serving.knative.dev`), regional endpoint.
 *
 * v1 deliberately, not v2: v1 returns the same Knative resource shape that
 * `gcloud run services describe --format=json` prints, so every existing
 * consumer of `metadata.labels` / `status.url` / `spec.template.spec.containers`
 * keeps working. v2 renames all of it (`uri`, `template.containers`) and would
 * mean rewriting each caller.
 */
export function runServiceUrl(service: string, project: string = PROJECT, region: string = REGION): string {
  return `https://${region}-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/${encodeURIComponent(project)}/services/${encodeURIComponent(service)}`;
}

/**
 * A page of the service list. `continueToken` resumes where the last page
 * stopped.
 *
 * The Knative list API paginates, and it does so with Kubernetes' `continue`
 * token rather than GCS's `pageToken` — verified live against this project:
 * `…/services?limit=2` answers with `metadata.continue: "AAZXnvY+3IU…"`. The
 * unlimited call returns all 25 services today with no token, so the truncation
 * does not fire yet; the command this replaced (`gcloud run services list`)
 * pages internally, so ignoring the token would be a silent regression waiting
 * on service #N. Silent is the operative word — a short list has no error in it,
 * it just omits somebody's app from the dashboard and lets `resolveSlug` mint a
 * fresh slug for an app that already exists.
 */
export function runServicesListUrl(project: string = PROJECT, region: string = REGION, continueToken?: string): string {
  const base = `https://${region}-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/${encodeURIComponent(project)}/services`;
  return continueToken ? `${base}?${new URLSearchParams({ continue: continueToken }).toString()}` : base;
}

/**
 * `objects.list` items → the release-relative paths the verifier expects.
 *
 * Mirrors what the gcloud path produced from `storage ls -r 'gs://b/prefix**'`:
 * strip the prefix, drop the prefix itself and any directory placeholder.
 */
export function relativeObjectNames(items: { name?: string }[], prefix: string): string[] {
  const out: string[] = [];
  for (const it of items ?? []) {
    const name = it?.name;
    if (typeof name !== "string" || !name.startsWith(prefix)) continue;
    const rel = name.slice(prefix.length);
    if (!rel || rel.endsWith("/")) continue;
    out.push(rel);
  }
  return out;
}

/**
 * REST returns `{ kind: "ServiceList", items: [...] }`; `gcloud run services
 * list --format=json` returns a bare array. Downstream code was written against
 * the bare array, so normalise here.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export function serviceListItems(body: any): any[] {
  if (Array.isArray(body)) return body;
  return Array.isArray(body?.items) ? body.items : [];
}

/**
 * The Kubernetes continuation token from a ServiceList, or null on the last page.
 *
 * A bare array (the gcloud shape) is never partial, so it has no token.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export function serviceListContinue(body: any): string | null {
  if (Array.isArray(body)) return null;
  const c = body?.metadata?.continue;
  return typeof c === "string" && c ? c : null;
}

/* -------------------------------------------------------------------------- */
/* Access token                                                               */
/* -------------------------------------------------------------------------- */

let tokenCache: TokenEntry | null = null;
/** The last metadata-server probe: null = never asked. */
let metadataProbe: MetadataProbe | null = null;
/** In-flight fetch, so N parallel REST calls do not each spawn gcloud. */
let tokenInFlight: Promise<string | null> | null = null;

/** Test seam. Also useful after a credential change in a long-lived process. */
export function resetTokenCache(): void {
  tokenCache = null;
  metadataProbe = null;
  tokenInFlight = null;
}

/** A 401/403 means the cached token is no good regardless of its stated expiry. */
export function invalidateToken(): void {
  tokenCache = null;
  tokenInFlight = null;
}

function gcloudCapture(args: string[], timeoutMs = 30_000): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    try {
      const p = spawn("gcloud", args, { env: ENV });
      let out = "";
      const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* already gone */ } finish(null); }, timeoutMs);
      p.stdout.on("data", (d: Buffer) => (out += d));
      p.stderr.on("data", () => { /* the fallback path reports its own errors */ });
      p.on("error", () => { clearTimeout(timer); finish(null); });
      p.on("close", (c) => { clearTimeout(timer); finish(c === 0 ? out : null); });
    } catch { finish(null); }
  });
}

/** The metadata server, when we are on Cloud Run. Sub-millisecond, no subprocess. */
async function tokenFromMetadata(): Promise<TokenEntry | null> {
  if (!shouldProbeMetadata(metadataProbe, Date.now())) return null;
  const fail = (): null => { metadataProbe = { ok: false, at: Date.now() }; return null; };
  try {
    const r = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) },
    );
    if (!r.ok) return fail();
    const j = (await r.json()) as { access_token?: string; expires_in?: number };
    if (!j?.access_token) return fail();
    metadataProbe = { ok: true, at: Date.now() };
    return { token: j.access_token, expiresAt: tokenExpiresAt(j.expires_in ?? 3600, Date.now()) };
  } catch {
    // Unreachable host, DNS failure, timeout: almost always local dev, but a
    // transient failure on Cloud Run looks identical, hence the retry window.
    return fail();
  }
}

async function tokenFromGcloud(): Promise<TokenEntry | null> {
  const out = await gcloudCapture(["auth", "print-access-token"]);
  const token = out?.trim();
  if (!token) return null;
  return { token, expiresAt: Date.now() + GCLOUD_TOKEN_TTL_MS };
}

/**
 * The last-resort token source, injectable.
 *
 * Test seam, and it earns its keep: without it, covering "the metadata server
 * answered with something unusable" means really running `gcloud auth
 * print-access-token` from a unit test — which needs a credential, costs about a
 * second, and pulls a live production token into a test process for no reason.
 * Production never calls the setter, so the default is the only thing that ever
 * runs outside `test/`.
 */
let fallbackTokenSource: () => Promise<TokenEntry | null> = tokenFromGcloud;

/** Test seam. Pass null to restore the real `gcloud auth print-access-token`. */
export function setFallbackTokenSource(fn: (() => Promise<TokenEntry | null>) | null): void {
  fallbackTokenSource = fn ?? tokenFromGcloud;
}

/**
 * An OAuth access token for the deployer identity, cached in memory until it is
 * (nearly) expired. Metadata server first, `gcloud auth print-access-token`
 * second. Returns null when neither works, which sends the caller to gcloud.
 *
 * A token judged unusable is never returned. That sounds obvious, and this
 * function used to do the opposite: it cleared the cache and then handed the
 * caller the very token it had just rejected. The doc on `tokenExpiresAt` claims
 * a too-short-lived token "lands in the past, which `tokenUsable` then rejects",
 * and that is only true now. Callers read `null` as "use gcloud" — which is a
 * working path — whereas a dead token is a 401 they mostly do not recover from
 * (lib/gcloud.ts `listBucketObjects` throws it at the dashboard; the repair
 * agent bakes it into a config for a whole session).
 *
 * Both sources are tried on their merits: a metadata token with only seconds of
 * life left is not usable, but it must not stop us asking gcloud.
 */
export async function accessToken(): Promise<string | null> {
  if (tokenUsable(tokenCache, Date.now())) return tokenCache!.token;
  if (tokenInFlight) return tokenInFlight;

  tokenInFlight = (async () => {
    const fromMetadata = await tokenFromMetadata();
    const entry = tokenUsable(fromMetadata, Date.now()) ? fromMetadata : await fallbackTokenSource();
    if (!tokenUsable(entry, Date.now())) { tokenCache = null; return null; }
    tokenCache = entry;
    return entry!.token;
  })().finally(() => { tokenInFlight = null; });

  return tokenInFlight;
}

/* -------------------------------------------------------------------------- */
/* Request plumbing                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The single try/catch covers token acquisition as well as the request.
 *
 * `accessToken()` cannot reject today — `tokenFromMetadata` and `tokenFromGcloud`
 * both swallow everything — so this looks redundant. It is not: this file's
 * contract is "nothing in here throws", every public helper below reaches the
 * network only through this function, and callers (app/api/deploy/route.ts,
 * lib/gcloud.ts) treat them as non-throwing. Leaving the token call outside made
 * that contract hold by luck rather than by structure: one future edit inside
 * the token path — a `JSON.parse`, a `new URL`, a rethrow — and every one of
 * those call sites gains a way to fail. The boundary belongs where the contract
 * is, not where the throw happens to be absent this week.
 */
async function authed(url: string, init: RequestInit & { userProject?: boolean } = {}): Promise<Response | null> {
  try {
    const token = await accessToken();
    if (!token) return null;
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
    };
    // Quota/billing attribution when the credential is a user account rather than
    // a service account. Matches the existing listBucketObjects call.
    if (init.userProject) headers["x-goog-user-project"] = PROJECT;
    const r = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (r.status === 401 || r.status === 403) invalidateToken();
    return r;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Cloud Storage                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every object under `prefix`, as paths relative to it. Replaces
 * `gcloud storage ls -r 'gs://<bucket>/<prefix>**'`.
 *
 * Pages properly — the API caps a page at 1000 objects and the existing
 * `listBucketObjects` helper's habit of ignoring `nextPageToken` would silently
 * under-report a large site, which here would fail its own verification.
 *
 * `[]` is a real answer (an empty release). `null` means fall back.
 */
export async function listObjectNames(bucket: string, prefix: string): Promise<string[] | null> {
  const names: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const r = await authed(objectsListUrl(bucket, prefix, pageToken), { userProject: true });
    if (!r || !r.ok) return null;
    let body: { items?: { name?: string }[]; nextPageToken?: string };
    try { body = await r.json(); } catch { return null; }
    names.push(...relativeObjectNames(body.items ?? [], prefix));
    if (!body.nextPageToken) return names;
    pageToken = body.nextPageToken;
  }
  return null; // absurdly large listing — let gcloud deal with it
}

/**
 * An object's bytes as text. Replaces `gcloud storage cat` — the single
 * slowest call on the static hot path.
 *
 * A 404 returns null (fall back) rather than "" so that a missing object is
 * reported by the same code path that reported it before this change.
 */
export async function readObjectText(bucket: string, name: string): Promise<string | null> {
  const r = await authed(objectMediaUrl(bucket, name), { userProject: true });
  if (!r || !r.ok) return null;
  try { return await r.text(); } catch { return null; }
}

/**
 * Write a small object. Replaces `gcloud storage cp - gs://…` for the release
 * pointer, so the bytes must be byte-identical: the release id raw, with no
 * trailing newline, exactly as `p.stdin.end(release)` wrote it.
 *
 * No `acl`/`predefinedAcl` is sent: the assets bucket has uniform bucket-level
 * access enabled, which rejects per-object ACLs outright.
 *
 * Returns false when the write did not happen, so the caller can run the
 * gcloud command instead. A simple upload is atomic — a failed one leaves the
 * previous pointer exactly where it was.
 */
export async function writeObject(bucket: string, name: string, body: string): Promise<boolean> {
  const r = await authed(objectInsertUrl(bucket, name), {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body,
    userProject: true,
  });
  return Boolean(r && r.ok);
}

/* -------------------------------------------------------------------------- */
/* Cloud Run                                                                  */
/* -------------------------------------------------------------------------- */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * One Cloud Run service, in the same Knative shape gcloud prints. Replaces
 * `gcloud run services describe <name> --format=json`.
 */
export async function describeServiceRest(service: string): Promise<any | null> {
  const r = await authed(runServiceUrl(service));
  if (!r || !r.ok) return null;
  try {
    const j = await r.json();
    return j && typeof j === "object" && !j.error ? j : null;
  } catch { return null; }
}

/**
 * Every Cloud Run service in the region, normalised to the bare array that
 * `gcloud run services list --format=json` produced.
 *
 * Follows `metadata.continue` to the end of the list. A partial answer here is
 * worse than no answer: every caller treats the result as complete, so a
 * truncated list reads as "that service does not exist" and `resolveSlug` builds
 * a duplicate app rather than redeploying the one that is already there. Hence
 * the page cap returning null (fall back to gcloud, which pages internally)
 * rather than returning what it has so far — same rule as `listObjectNames`.
 */
export async function listServicesRest(): Promise<any[] | null> {
  const services: any[] = [];
  let continueToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const r = await authed(runServicesListUrl(PROJECT, REGION, continueToken));
    if (!r || !r.ok) return null;
    let j: any;
    try { j = await r.json(); } catch { return null; }
    if (!j || typeof j !== "object" || j.error) return null;
    // A ServiceList with no `items` at all is a shape we do not recognise;
    // treat it as a failure rather than as "the project has no services".
    if (!Array.isArray(j) && !Array.isArray(j.items)) return null;
    const next = serviceListContinue(j);
    // A token that does not advance means the server is repeating itself. Both
    // ways out of that are wrong — spin forever, or return a list with the same
    // page counted twice — so it is a failure, and failure here means gcloud.
    if (next && next === continueToken) return null;
    services.push(...serviceListItems(j));
    if (!next) return services;
    continueToken = next;
  }
  return null; // absurd number of pages — hand it back to gcloud
}
