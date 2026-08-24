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
import { rootDomain, rootDomains } from "./roots";
import { memo } from "./memo";

const BASE = (process.env.UMAMI_URL ?? "").replace(/\/$/, "");
const USER = process.env.UMAMI_USER ?? "admin";
const PASSWORD = process.env.UMAMI_PASSWORD ?? "";
/** The CANONICAL root: a website is registered under one name, not two. */
const ROOT_DOMAIN = rootDomain();

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
  // MATCHED AGAINST EVERY ROOT, NOT ONLY THE CANONICAL ONE.
  //
  // A website is created under whichever root was canonical that day, and the
  // canonical root CHANGED — every site in the running instance is registered
  // as `<slug>.supersonic.cv` while new ones would be `<slug>.thebay.cloud`.
  // Looking up by the canonical name alone therefore misses every existing site
  // the moment a rename lands, and this function's answer to "not found" is to
  // CREATE ONE: a second site for the same app, which the panel would then read
  // while the app's real visitors went on arriving in the first. Silent, and
  // indistinguishable from an app nobody visits.
  //
  // The name is matched too, because that is what an operator sees in umami and
  // what the backfill wrote; the roots are matched because that is what this
  // function itself wrote. Either is proof the app already has a site.
  const names = new Set(rootDomains().map((r) => `${slug}.${r}`));
  const hit = existing.find((w) => names.has(w.domain) || w.name === slug);
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

/** How far back a window reaches, in milliseconds. Chosen from a list, never parsed. */
const WINDOWS: Record<string, number> = {
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export interface WebsiteStats {
  range: string;
  visitors: number;
  views: number;
  visits: number;
  bounces: number;
  totalTime: number;
  /**
   * The same window, one window earlier — so a caller can say "up 40%" without
   * asking twice. Zero when this umami offers no comparison at all, which is a
   * reason to show no change rather than to show a change of nothing.
   */
  prevVisitors: number;
  prevViews: number;
  /**
   * `null` means the list could not be read, and that is NOT an empty list.
   *
   * This is the distinction whose absence hid the metric rename for weeks: a
   * 400 was turned into `[]` here and rendered as "no pages", so the panel said
   * nobody had visited any page of an app with 179 page views. Every caller has
   * to tell the two apart, which it can only do if this stays nullable.
   */
  pages: { x: string; y: number }[] | null;
  referrers: { x: string; y: number }[] | null;
}

/**
 * THREE SHAPES OF /stats, AND THIS IS NOT DEFENSIVENESS FOR ITS OWN SAKE.
 *
 * Umami has rewritten this response twice and every version is deployed
 * somewhere:
 *
 *   flat      {"pageviews":179,"visitors":10,"comparison":{"visitors":0}}
 *   paired    {"pageviews":{"value":179,"prev":22}}
 *   delta     {"pageviews":{"value":179,"change":157}}
 *
 * The instance running in front of us today is the FLAT one — verified against
 * it on 24 Aug: `{"pageviews":179,"visitors":10,"visits":35,...}`. This module
 * read `m.value` and nothing else, and `.value` on a number is `undefined`, so
 * every figure came back 0 and the panel drew a confident "0 visitors" over an
 * app with ten of them. That is the failure the `null`-versus-zero rule exists
 * to prevent, arriving through the one door it does not cover: a read that
 * SUCCEEDS and means nothing.
 *
 * The edge parses the same three shapes for the same reason
 * (services/proxy/src/analytics.ts). Two copies because the two run in different
 * services with no shared package between them; they are kept identical on
 * purpose, and a change to one belongs in both.
 */
type Metric = number | { value?: number; prev?: number; change?: number } | undefined;

const num = (m: Metric): number => (typeof m === "number" ? Math.round(m) : Math.round(m?.value ?? 0));

/** The same metric over the window BEFORE this one, however this build reports it. */
function before(m: Metric, comparison: Record<string, number> | undefined, key: string): number {
  // Flat: the previous window is a sibling object under the same name, and it
  // is reported as the previous VALUE, not as a delta.
  if (typeof m === "number") return Math.round(comparison?.[key] ?? 0);
  if (typeof m?.prev === "number") return Math.round(m.prev);
  // The delta shape reports the CHANGE, so the previous window is value − change.
  if (typeof m?.change === "number" && typeof m?.value === "number") return Math.round(m.value - m.change);
  return 0;
}

interface Stats {
  pageviews?: Metric; visitors?: Metric; uniques?: Metric;
  visits?: Metric; bounces?: Metric; totaltime?: Metric;
  comparison?: Record<string, number>;
}

/**
 * One ranked list, under whichever name this umami calls it.
 *
 * Tries the names in order and returns the first that ANSWERS. An empty list is
 * an answer and stops the search; only a refusal moves on. `null` when none of
 * them answered — see WebsiteStats.pages for why that is not `[]`.
 *
 * `type=path` first, `type=url` behind it: umami renamed this metric and the
 * old name is not deprecated but REJECTED — `type=url` answers 400 on the
 * instance running today while `type=path` returns the data. Neither name is
 * right on every version, so both are tried rather than one being guessed at.
 */
async function metricList(
  websiteId: string,
  q: string,
  types: string[],
): Promise<{ x: string; y: number }[] | null> {
  for (const type of types) {
    const r = await api(`/api/websites/${websiteId}/metrics?${q}&type=${type}&limit=10`);
    if (r && r.ok) {
      const j = (await r.json().catch(() => null)) as { x: string; y: number }[] | null;
      if (Array.isArray(j)) return j;
      return null;
    }
    if (r) console.error(`umami: metrics type=${type} for ${websiteId} — ${r.status}`);
  }
  return null;
}

/**
 * One window of an app's audience, read straight from umami.
 *
 * Added because chat's analytics tool was fetching the app's OWN proxy at
 * `/_dashboard/analytics` — an owner-only endpoint on a different host — which meant
 * it needed a session cookie that a server cannot reliably present, only worked from
 * a deployed control plane, and depended on Cloud Run egress reaching a public
 * hostname to answer a question the control plane can answer directly. Three failure
 * modes for a read that was always available locally.
 *
 * `null` means umami could not be asked, which is NOT zero visitors. Every caller has
 * to say those differently: "nobody came" and "we could not count" are opposite
 * answers, and reading unreachable as zero is how a dashboard lies.
 */
/**
 * Visitor counts, remembered for a minute.
 *
 * Umami aggregates on its own schedule and its own numbers are already minutes
 * behind the event that produced them, so a cached minute adds nothing to the
 * error — and this is the read that reaches another service over HTTP, which is
 * the slowest of the nine on the Dev screen after the ones that spawn processes.
 */
export function websiteStatsCached(websiteId: string, range = "1d") {
  return memo(`umami:${websiteId}:${range}`, 60_000, () => websiteStats(websiteId, range));
}

export async function websiteStats(
  websiteId: string,
  range = "1d",
): Promise<WebsiteStats | null> {
  const span = WINDOWS[range] ?? WINDOWS["1d"];
  const endAt = Date.now();
  const startAt = endAt - span;
  const q = `startAt=${startAt}&endAt=${endAt}`;

  const [statsRes, pages, referrers] = await Promise.all([
    api(`/api/websites/${websiteId}/stats?${q}`),
    metricList(websiteId, q, ["path", "url"]),
    metricList(websiteId, q, ["referrer"]),
  ]);
  if (!statsRes || !statsRes.ok) {
    if (statsRes) console.error(`umami: stats for ${websiteId} — ${statsRes.status}`);
    return null;
  }

  const s = (await statsRes.json().catch(() => null)) as Stats | null;
  if (!s) return null;

  const visitors = num(s.visitors ?? s.uniques);
  return {
    range,
    visitors,
    views: num(s.pageviews),
    visits: num(s.visits),
    bounces: num(s.bounces),
    totalTime: num(s.totaltime),
    prevVisitors: before(s.visitors ?? s.uniques, s.comparison, s.visitors !== undefined ? "visitors" : "uniques"),
    prevViews: before(s.pageviews, s.comparison, "pageviews"),
    pages,
    referrers,
  };
}

/* ==========================================================================
   EVERYTHING UMAMI HAS, FOR THE SCREEN THAT ASKED FOR IT

   `websiteStats` above is the CHEAP read: six numbers and two lists, on a path
   that is polled. This is the other one — every dimension the instance will
   answer for, the time series, who is on the site this second, and the last few
   visitors — and it happens once, when somebody opens the Analytics screen, for
   the window that screen asked for.

   Two reads rather than one because they have different budgets and different
   lifetimes, not because the data differs.
   ========================================================================== */

/**
 * What can be asked for, and what to call it where a person reads it.
 *
 * The names are tried IN ORDER and the first that answers wins — `path` is what
 * this instance calls the pages metric and `url` is what an older one calls it,
 * and neither is right on both. A dimension the instance refuses (this one
 * refuses `host`) is simply absent from the answer, because a missing column
 * beside a true visitor count is a worse reading, not an unreadable one.
 *
 * Verified against the running instance on 25 Aug: path, title, referrer, query,
 * browser, os, device, screen, country, region, city, language, event, tag,
 * channel, entry and exit all answer; url and host are 400.
 */
export const DIMENSIONS: [string, string[]][] = [
  ["pages", ["path", "url"]],
  ["entry", ["entry", "entry_url"]],
  ["exit", ["exit", "exit_url"]],
  ["titles", ["title"]],
  ["from", ["referrer"]],
  ["channel", ["channel"]],
  ["query", ["query"]],
  ["country", ["country"]],
  ["region", ["region"]],
  ["city", ["city"]],
  ["language", ["language"]],
  ["browser", ["browser"]],
  ["os", ["os"]],
  ["device", ["device"]],
  ["screen", ["screen"]],
  ["event", ["event"]],
];

/** One point of the time series. `t` is the start of the bucket, in ms. */
export interface Point { t: number; views: number; visitors: number }

/** One visitor, as umami remembers them. No name, no id that means anything. */
export interface Visitor {
  id: string;
  firstAt: string;
  lastAt: string;
  visits: number;
  views: number;
  country: string | null;
  city: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
}

export interface WebsiteDetail extends WebsiteStats {
  startAt: number;
  endAt: number;
  /** hour for a day, day for anything longer — what the series is bucketed by. */
  unit: string;
  /** People on the site right now, or null when umami would not say. */
  active: number | null;
  series: Point[];
  /** Keyed by the names in DIMENSIONS. A dimension this instance refuses is absent. */
  dims: Record<string, [string, number][]>;
  visitors_recent: Visitor[];
}

/** Ranked rows, trimmed, with the nameless bucket given a name. */
function rank(rows: { x: string | null; y: number }[] | null, blank: string, keep = 8): [string, number][] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => typeof r?.y === "number" && r.y > 0)
    .slice(0, keep)
    .map((r) => [r.x && String(r.x).trim() ? String(r.x) : blank, Math.round(r.y)] as [string, number]);
}

/**
 * Two series into one, on the buckets umami actually returned.
 *
 * Umami answers pageviews and sessions as SEPARATE arrays and omits the buckets
 * with nothing in them — from either one independently. Zipping by index would
 * therefore pair a Tuesday's views with a Thursday's visitors as soon as one
 * quiet day appeared in one array and not the other. Keyed by timestamp, and the
 * gaps are filled with zeroes so a chart drawn from this has an x-axis that is
 * time rather than a list of the days something happened.
 */
export function zip(
  views: { x: string; y: number }[] | undefined,
  sessions: { x: string; y: number }[] | undefined,
  startAt: number,
  endAt: number,
  unit: string,
): Point[] {
  const step = unit === "hour" ? 3600_000 : 86400_000;
  const at = (x: string) => {
    const ms = Date.parse(x.endsWith("Z") || x.includes("+") ? x : `${x}Z`);
    return Number.isFinite(ms) ? Math.floor(ms / step) * step : NaN;
  };
  const v = new Map<number, number>();
  const p = new Map<number, number>();
  for (const r of views ?? []) { const t = at(r.x); if (!Number.isNaN(t)) v.set(t, Math.round(Number(r.y) || 0)); }
  for (const r of sessions ?? []) { const t = at(r.x); if (!Number.isNaN(t)) p.set(t, Math.round(Number(r.y) || 0)); }

  const first = Math.floor(startAt / step) * step;
  const last = Math.floor(endAt / step) * step;
  const out: Point[] = [];
  // Bounded: 30 days of hours would be 720 points, and nothing asks for that —
  // but a clock skew or a bad range must not turn into a million-point loop.
  for (let t = first; t <= last && out.length < 800; t += step) {
    out.push({ t, views: v.get(t) ?? 0, visitors: p.get(t) ?? 0 });
  }
  return out;
}

/** People on the site this second. Null, not 0, when umami would not say. */
function activeCount(raw: unknown): number | null {
  if (typeof raw === "number") return Math.round(raw);
  if (Array.isArray(raw)) return raw.length;
  if (raw && typeof raw === "object") {
    const o = raw as { visitors?: number; x?: number };
    if (typeof o.visitors === "number") return Math.round(o.visitors);
    if (typeof o.x === "number") return Math.round(o.x);
  }
  return null;
}

function visitorRow(r: Record<string, unknown>): Visitor {
  const str = (k: string) => (typeof r[k] === "string" && r[k] ? (r[k] as string) : null);
  return {
    id: String(r.id ?? ""),
    firstAt: String(r.firstAt ?? ""),
    lastAt: String(r.lastAt ?? ""),
    visits: Math.round(Number(r.visits) || 0),
    views: Math.round(Number(r.views) || 0),
    country: str("country"),
    city: str("city"),
    device: str("device"),
    browser: str("browser"),
    os: str("os"),
  };
}

/**
 * The whole picture for one app over one window.
 *
 * Every query goes out together, so the wall clock is the slowest one rather
 * than the sum — about twenty of them, which is why this is not on the polled
 * path. A dimension that fails is absent; the reading survives. Only `/stats`
 * failing makes the whole thing null, because without the headline numbers
 * there is nothing to draw a screen around.
 */
export async function websiteDetail(websiteId: string, range = "7d"): Promise<WebsiteDetail | null> {
  const span = WINDOWS[range] ?? WINDOWS["7d"];
  const endAt = Date.now();
  const startAt = endAt - span;
  const unit = span <= WINDOWS["1d"] ? "hour" : "day";
  const q = `startAt=${startAt}&endAt=${endAt}`;

  const json = async <T,>(r: Response | null): Promise<T | null> =>
    r && r.ok ? ((await r.json().catch(() => null)) as T | null) : null;

  const [base, seriesRes, activeRes, sessionsRes, ...ranked] = await Promise.all([
    websiteStats(websiteId, range),
    api(`/api/websites/${websiteId}/pageviews?${q}&unit=${encodeURIComponent(unit)}`),
    api(`/api/websites/${websiteId}/active`),
    api(`/api/websites/${websiteId}/sessions?${q}&pageSize=8&page=1`),
    ...DIMENSIONS.map(([, names]) => metricList(websiteId, q, names)),
  ]);
  if (!base) return null;

  const series = await json<{ pageviews?: { x: string; y: number }[]; sessions?: { x: string; y: number }[] }>(seriesRes);
  const sessions = await json<{ data?: Record<string, unknown>[] }>(sessionsRes);

  const dims: Record<string, [string, number][]> = {};
  DIMENSIONS.forEach(([key], i) => {
    const rows = rank(ranked[i], key === "from" ? "direct" : key === "query" ? "none" : "unknown");
    // Absent rather than empty when the instance refused the question: an empty
    // list is a claim about the app, and this one would be a claim about umami.
    if (ranked[i] !== null) dims[key] = rows;
  });

  return {
    ...base,
    startAt,
    endAt,
    unit,
    active: activeCount(await json<unknown>(activeRes)),
    series: zip(series?.pageviews, series?.sessions, startAt, endAt, unit),
    dims,
    visitors_recent: (sessions?.data ?? []).map(visitorRow),
  };
}

/** Test seam: the parsers above, exercised without a network. */
export const __test = { num, before, zip, activeCount, rank };
