import { mintIdToken } from "./idtoken";
import { isCloudRunTarget } from "./upstream";

/**
 * Read from the environment here rather than through `config`, and that is not
 * a style choice.
 *
 * `config` throws at import time when AUTH_SECRET is unset — which is correct
 * for a proxy that must not boot half-configured, and wrong for this module,
 * because `reading.ts` imports it and `reading.ts` is the piece the panel and
 * the assembler are unit-tested through. Importing config here turned two
 * env-free test files into two failures about a secret neither of them uses.
 *
 * Lazy, not module-level constants, so a test can set the variables after
 * import and so an env change does not need a redeploy to be picked up by a
 * process that reads it per call.
 */
const umami = () => ({
  url: (process.env.UMAMI_URL ?? "").replace(/\/$/, "").trim(),
  user: process.env.UMAMI_USER ?? "admin",
  password: (process.env.UMAMI_PASSWORD ?? "").trim(),
});

/**
 * The invoker credential, in the header that is NOT `Authorization`.
 *
 * Umami is deployed `--no-allow-unauthenticated`, so Cloud Run wants a Google
 * ID token before the container ever sees the request. Umami itself wants its
 * OWN bearer token, in `Authorization`. There is one `Authorization` header,
 * and forward.ts already carries the scar tissue from putting the wrong token
 * in it: Cloud Run reads `X-Serverless-Authorization` first when present and
 * leaves `Authorization` untouched for the container, which is the entire
 * reason that header exists.
 *
 * Empty for a target that is not Cloud Run — a local umami in docker, which is
 * how this is developed against. `idTokenFor` reaches the metadata server and
 * throws when there isn't one, so asking unconditionally would make every read
 * fail on a laptop.
 */
async function invoker(base: string): Promise<Record<string, string>> {
  if (!isCloudRunTarget(base)) return {};
  return { "X-Serverless-Authorization": `Bearer ${await mintIdToken(new URL(base).origin)}` };
}

/**
 * People, read back out of umami and shaped for the panel.
 *
 * THE LINE THIS KEEPS
 *
 * The edge counts requests; umami counts people. They will disagree and both
 * will be right — one page view with eleven assets on it is eleven requests and
 * one visitor, and a client-side route change is a visitor moving and no
 * request at all. Nothing here is ever added to, subtracted from, or shown as
 * the same number as the live half. `Reading` carries both because they answer
 * different questions: `live` answers *machine*, this answers *people*.
 *
 * It also cannot replace the live half, whatever it looks like. A broken app
 * serves 500s and runs no JavaScript, so this would show traffic vanishing and
 * be unable to say why. That is the whole reason the edge keeps measuring.
 */
export interface Audience {
  visitors: number;
  views: number;
  /** Percent, 0–100. Sessions that were one page and then gone. */
  bounce: number;
  /** Mean session length in seconds. */
  avgSeconds: number;
  /**
   * Percent change in visitors against the window before this one, or null when
   * there is no previous window worth comparing to. Null rather than 0: an app
   * that went up yesterday has no "before", and "+0%" is a claim about a week
   * that did not happen.
   */
  change: number | null;
  pages: [string, number][];
  from: [string, number][];
  on: [string, number][];
}

/**
 * Whether this app's audience half was read, and if not, why not.
 *
 * The same three-way honesty the builds half already keeps, for the same
 * reason. A window we could not read is NOT an app nobody visited, and with one
 * boolean there is no way to say so — an umami that is down would render, to a
 * person and to an agent alike, as "nobody has ever opened this".
 *
 * `off` is a fourth thing again: the owner turned it off, so there is nothing to
 * read and nothing is wrong.
 */
export type AudienceWindow = "read" | "unreadable" | "off";

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * One reading per app per minute, at most.
 *
 * The panel polls every three seconds. Thirty-two apps with a panel open would
 * otherwise be six hundred admin queries a minute against an instance sized for
 * a 2 KB tracker, and the first thing to break would be the collection endpoint
 * — the analytics falling over because somebody was looking at the analytics.
 */
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: Audience | null }>();

/** Test seam, and the module's whole state. */
export function resetAudience(): void {
  cache.clear();
}

let token: { value: string; until: number } | null = null;
const TOKEN_MS = 6 * 60 * 60 * 1000;

async function authToken(): Promise<string | null> {
  if (token && Date.now() < token.until) return token.value;
  const u = umami();
  const r = await fetch(`${u.url}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await invoker(u.url)) },
    body: JSON.stringify({ username: u.user, password: u.password }),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`umami login ${r.status}`);
  const j = (await r.json()) as { token?: string };
  if (!j.token) throw new Error("umami login returned no token");
  token = { value: j.token, until: Date.now() + TOKEN_MS };
  return j.token;
}

async function get<T>(path: string): Promise<T> {
  const t = await authToken();
  const base = umami().url;
  const r = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${t}`, ...(await invoker(base)) },
    // Short, and deliberately shorter than the panel's own poll interval. This
    // sits in the middle of a request the owner is waiting on; a hung umami must
    // degrade to "unreadable" quickly rather than hold /_xray open.
    signal: AbortSignal.timeout(5000),
  });
  if (r.status === 401) {
    // The token expired earlier than we assumed. Throw it away so the next
    // attempt logs in again instead of failing forever with a stale JWT.
    token = null;
    throw new Error("umami rejected the token");
  }
  if (!r.ok) throw new Error(`umami ${path} ${r.status}`);
  return (await r.json()) as T;
}

/**
 * THREE SHAPES, AND THIS IS NOT DEFENSIVENESS FOR ITS OWN SAKE.
 *
 * `/stats` has been rewritten twice in umami's own life and every version is
 * still deployed somewhere:
 *
 *   flat      {"pageviews":3,"visitors":2,"comparison":{"visitors":0}}
 *   paired    {"pageviews":{"value":3,"prev":1}}
 *   delta     {"pageviews":{"value":3,"change":2}}
 *
 * The one running in front of us today is the flat one, which the first version
 * of this file did not read at all — `m.value` on a number is undefined, so
 * every field came back 0 and the panel would have drawn a confident "nobody
 * visited" over an app with visitors. That is the exact failure the whole
 * `unreadable` distinction exists to prevent, arriving through the door it does
 * not cover: a read that SUCCEEDS and means nothing.
 *
 * So both are parsed, and neither is guessed at.
 */
type Metric = number | { value?: number; prev?: number; change?: number } | undefined;
interface Stats {
  pageviews?: Metric; visitors?: Metric; uniques?: Metric;
  visits?: Metric; bounces?: Metric; totaltime?: Metric;
  /** The flat shape puts the previous window here, as a sibling object. */
  comparison?: Record<string, number>;
}
type Rank = { x: string | null; y: number }[];

const num = (m: Metric): number => {
  if (typeof m === "number") return Math.round(m);
  return Math.round(m?.value ?? 0);
};

/** The same metric over the window BEFORE this one, however this build reports it. */
function before(m: Metric, comparison: Record<string, number> | undefined, key: string): number {
  // Flat: the previous window is a sibling object keyed by the same name. Note
  // that umami reports it as the previous VALUE, not as a delta.
  if (typeof m === "number") return Math.round(comparison?.[key] ?? 0);
  if (typeof m?.prev === "number") return Math.round(m.prev);
  // The delta shape reports the CHANGE, so the previous window is value − change.
  if (typeof m?.change === "number" && typeof m?.value === "number") return Math.round(m.value - m.change);
  return 0;
}

/**
 * Ranked lists, trimmed and made presentable.
 *
 * `x` is null for a direct visit with no referrer, which is most of them for an
 * app somebody shared as a link; it becomes "direct" rather than being dropped,
 * because "where did they come from" with the largest answer missing is worse
 * than useless.
 */
function rank(rows: Rank | null | undefined, blank: string): [string, number][] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => typeof r?.y === "number" && r.y > 0)
    .slice(0, 8)
    .map((r) => [r.x && r.x.trim() ? r.x : blank, Math.round(r.y)] as [string, number]);
}

/**
 * One ranked list, under whichever name this umami calls it.
 *
 * Tries the names in order and returns the first that answers. An empty list is
 * an ANSWER — nobody visited — and stops the search; only a refusal moves on.
 * Returns [] when none of them work, because a missing column beside the
 * headline numbers is a worse reading, not an unreadable one: the visitor count
 * is still true and the panel should still show it.
 */
async function metric(websiteId: string, q: string, types: string[]): Promise<Rank> {
  for (const type of types) {
    try {
      return await get<Rank>(`/api/websites/${websiteId}/metrics?${q}&type=${type}&limit=10`);
    } catch {
      continue;
    }
  }
  return [];
}

/**
 * One app's audience, or null when umami could not be read.
 *
 * Null is a real answer here and is never flattened into zeroes upstream — see
 * AudienceWindow. The cache holds nulls too, and on purpose: an umami that is
 * down should be asked once a minute, not once every three seconds by every
 * open panel at once.
 */
export async function audienceFor(websiteId: string, now: number = Date.now()): Promise<Audience | null> {
  if (!umami().url || !websiteId) return null;
  const hit = cache.get(websiteId);
  if (hit && now - hit.at < CACHE_MS) return hit.value;

  const endAt = now;
  const startAt = now - WINDOW_MS;
  const q = `startAt=${startAt}&endAt=${endAt}`;

  let value: Audience | null = null;
  try {
    const [stats, pages, from, on] = await Promise.all([
      get<Stats>(`/api/websites/${websiteId}/stats?${q}`),
      // `path`, with `url` behind it. Umami renamed this metric and the old name
      // is now a 400 — not an empty list, a REFUSAL, which took the whole read
      // down with it and reported an app with visitors as unreadable. One name
      // is right on any given instance and neither is right on all of them.
      metric(websiteId, q, ["path", "url"]),
      metric(websiteId, q, ["referrer"]),
      metric(websiteId, q, ["device"]),
    ]);

    const visitors = num(stats.visitors ?? stats.uniques);
    // Sessions, which is what a bounce and a duration are per — not visitors and
    // not views. Falling back to visitors keeps the arithmetic sane on an umami
    // that does not report `visits`; falling back to views would divide a
    // per-session number by a per-request one and print a plausible lie.
    const sessions = num(stats.visits) || visitors;
    const bounces = num(stats.bounces);
    const totaltime = num(stats.totaltime);
    const prev = before(stats.visitors ?? stats.uniques, stats.comparison, stats.visitors !== undefined ? "visitors" : "uniques");

    value = {
      visitors,
      views: num(stats.pageviews),
      bounce: sessions ? Math.round((bounces / sessions) * 100) : 0,
      avgSeconds: sessions ? Math.round(totaltime / sessions) : 0,
      // Only against a previous window that actually had somebody in it. Percent
      // change from zero is infinity, and every honest rendering of it is a
      // sentence rather than a number.
      change: prev > 0 ? Math.round(((visitors - prev) / prev) * 100) : null,
      pages: rank(pages, "/"),
      from: rank(from, "direct"),
      on: rank(on, "unknown"),
    };
  } catch (e) {
    // Once per window per app, not once per poll: the cache below holds the null
    // for a minute, so this logs at the rate umami is actually being asked.
    console.error(`analytics: could not read ${websiteId} —`, e instanceof Error ? e.message : e);
    value = null;
  }

  cache.set(websiteId, { at: now, value });
  return value;
}

/* ==========================================================================
   EVERYTHING UMAMI HAS, ON DEMAND
   ==========================================================================

   `audienceFor` above is the cheap read: six numbers and three lists, carried
   in the reading so the home cell can say "1,284 today" without a second round
   trip. It is deliberately small because it sits inline on /_xray, which the
   panel polls every three seconds — and the cache below it exists because
   thirty-two open panels would otherwise be six hundred admin queries a minute
   against an instance sized for a 2KB tracker.

   This is the other read: every dimension umami will answer for, its time
   series, and who is on the site this second. It is NOT in the reading, and
   that is the whole point — it happens once, when somebody opens the Analytics
   screen, for the window they asked for. Twenty-odd queries on a path nobody
   polls is fine; the same twenty on /_xray would be the failure the comment
   above warns about.

   WHAT UMAMI DOES NOT HAVE

   Session replay. There is no recording and no playback in the product — that
   is a different category of tool. `sessions` below is the nearest real thing:
   who came, what they were on, and the order they hit things in.
*/

/** Every ranked dimension, and the names umami has called each one. */
const DIMENSIONS: [string, string[]][] = [
  ["pages", ["path", "url"]],
  ["entry", ["entry", "entry_url"]],
  ["exit", ["exit", "exit_url"]],
  ["titles", ["title"]],
  ["query", ["query"]],
  ["from", ["referrer"]],
  ["hosts", ["host"]],
  ["browser", ["browser"]],
  ["os", ["os"]],
  ["on", ["device"]],
  ["screen", ["screen"]],
  ["language", ["language"]],
  ["country", ["country"]],
  ["region", ["region"]],
  ["city", ["city"]],
  ["event", ["event"]],
  ["tag", ["tag"]],
];

/** What a dimension is called where a person reads it, and its empty label. */
export const DIMENSION_LABELS: Record<string, [string, string]> = {
  pages: ["Most opened", "/"],
  entry: ["Where they came in", "/"],
  exit: ["Where they left", "/"],
  titles: ["By page title", "untitled"],
  query: ["Search terms", "none"],
  from: ["How they got here", "direct"],
  hosts: ["Which address they used", "unknown"],
  browser: ["Browser", "unknown"],
  os: ["Operating system", "unknown"],
  on: ["Device", "unknown"],
  screen: ["Screen size", "unknown"],
  language: ["Language", "unknown"],
  country: ["Country", "unknown"],
  region: ["Region", "unknown"],
  city: ["City", "unknown"],
  event: ["Events", "unnamed"],
  tag: ["Tags", "untagged"],
};

export interface Detail {
  startAt: number;
  endAt: number;
  unit: string;
  visitors: number;
  views: number;
  visits: number;
  bounce: number;
  avgSeconds: number;
  change: number | null;
  /** On the site this second, from umami rather than from the edge. */
  active: number;
  /** The shape of the window: one point per unit. */
  series: { t: string; views: number; sessions: number }[];
  /** Every dimension umami answered for, keyed as in DIMENSIONS. */
  dims: Record<string, [string, number][]>;
}

/** `/active` has been an array of one and an object, depending on the build. */
function activeCount(a: unknown): number {
  if (Array.isArray(a)) return Math.round(Number((a[0] as { x?: number; visitors?: number })?.x ?? (a[0] as { visitors?: number })?.visitors ?? 0));
  if (a && typeof a === "object") return Math.round(Number((a as { visitors?: number }).visitors ?? 0));
  return Math.round(Number(a) || 0);
}

type Series = { pageviews?: { x: string; y: number }[]; sessions?: { x: string; y: number }[] };

/** Views and sessions per interval, zipped into one row per point. */
function zipSeries(s: Series | null | undefined): Detail["series"] {
  const views = Array.isArray(s?.pageviews) ? s!.pageviews! : [];
  const sess = Array.isArray(s?.sessions) ? s!.sessions! : [];
  const bySession = new Map(sess.map((p) => [p.x, Math.round(p.y) || 0]));
  return views.map((p) => ({ t: p.x, views: Math.round(p.y) || 0, sessions: bySession.get(p.x) ?? 0 }));
}

const detailCache = new Map<string, { at: number; value: Detail | null }>();
const DETAIL_CACHE_MS = 20_000;

/** Test seam, beside resetAudience for the same reason. */
export function resetDetail(): void {
  detailCache.clear();
}

/**
 * The whole picture for one app over one window.
 *
 * Every query goes out together, so the wall clock is the slowest one rather
 * than the sum, and a dimension this umami has never heard of comes back empty
 * instead of taking the read down with it — `metric` already tries each name and
 * gives up quietly, because a missing column beside a true visitor count is a
 * worse reading and not an unreadable one.
 */
export async function analyticsDetail(
  websiteId: string,
  startAt: number,
  endAt: number,
  unit: string,
  now: number = Date.now(),
): Promise<Detail | null> {
  if (!umami().url || !websiteId) return null;
  const key = `${websiteId}:${startAt}:${endAt}:${unit}`;
  const hit = detailCache.get(key);
  if (hit && now - hit.at < DETAIL_CACHE_MS) return hit.value;

  const q = `startAt=${startAt}&endAt=${endAt}`;
  let value: Detail | null = null;
  try {
    const [stats, series, active, ...ranked] = await Promise.all([
      get<Stats>(`/api/websites/${websiteId}/stats?${q}`),
      get<Series>(`/api/websites/${websiteId}/pageviews?${q}&unit=${encodeURIComponent(unit)}`).catch(() => null),
      get<unknown>(`/api/websites/${websiteId}/active`).catch(() => null),
      ...DIMENSIONS.map(([, names]) => metric(websiteId, q, names)),
    ]);

    const visitors = num(stats.visitors ?? stats.uniques);
    const visits = num(stats.visits) || visitors;
    const prev = before(stats.visitors ?? stats.uniques, stats.comparison, stats.visitors !== undefined ? "visitors" : "uniques");
    const dims: Record<string, [string, number][]> = {};
    DIMENSIONS.forEach(([key2], i) => {
      dims[key2] = rank(ranked[i], DIMENSION_LABELS[key2]?.[1] ?? "unknown");
    });

    value = {
      startAt, endAt, unit,
      visitors,
      views: num(stats.pageviews),
      visits,
      bounce: visits ? Math.round((num(stats.bounces) / visits) * 100) : 0,
      avgSeconds: visits ? Math.round(num(stats.totaltime) / visits) : 0,
      change: prev > 0 ? Math.round(((visitors - prev) / prev) * 100) : null,
      active: activeCount(active),
      series: zipSeries(series),
      dims,
    };
  } catch (e) {
    console.error(`analytics: could not read detail for ${websiteId} —`, e instanceof Error ? e.message : e);
    value = null;
  }
  detailCache.set(key, { at: now, value });
  return value;
}
