/**
 * What a live app is doing right now, for its owner.
 *
 * The proxy already stands on the path of every request to every hosted app and,
 * until this file, recorded none of it. That is the whole opportunity: nobody
 * else can see this without the owner instrumenting their code — we can see it
 * because we own the runtime.
 *
 * Deliberately in memory and deliberately small. There is no table, no retention
 * story and no history: this answers "what is happening", not "what happened".
 * The proxy runs at min-instances=1, so one process sees everything; scaled out,
 * each instance would answer for its own share and the numbers would be wrong in
 * a way nobody could see. Written down rather than guarded against, exactly as
 * the room's sessions are.
 *
 * The honesty rule the room established applies here too, in a different shape.
 * An empty panel after a proxy release is NOT an app with no traffic, and the two
 * must never look alike — hence `since`, which every reader has to render.
 */

/** How long after a request a visitor still counts as being here. */
const HERE_MS = 90_000;
/** Durations kept per path to answer for its shape. Bounded, so an app under
 *  load costs the same memory as an idle one. */
const SAMPLES = 60;
/** Paths remembered per app. A crawler walking a wildcard route must not be able
 *  to grow this without bound. */
const MAX_PATHS = 60;
/** Apps remembered. Same reasoning: the key space is public. */
const MAX_APPS = 300;

interface PathStat {
  hits: number;
  /** Requests the app itself failed — 5xx. Lifetime, since this process started. */
  broke: number;
  /** Requests for something that is not there — 4xx. Lifetime, same window. */
  missing: number;
  /** Recent durations, newest last, capped at SAMPLES. */
  ms: number[];
  lastAt: number;
  /**
   * When the app last failed here. 0 = it never has.
   *
   * A count on its own cannot answer the only question worth asking about a
   * break — is it happening now. Without a time, a path that failed all morning
   * and has been healthy since still reads as the app's worst problem until the
   * proxy restarts, which is a fact about our memory dressed up as a fact about
   * the app.
   */
  lastBrokeAt: number;
  /**
   * When the current unbroken run of failures began. 0 = the last request here
   * succeeded, so it is not failing now.
   *
   * Cleared by a success and never by a 4xx: somebody asking for a page that is
   * not there, in the middle of an outage, is not the app recovering.
   */
  brokeSince: number;
}

interface Presence {
  /** Who, when we know — the proxy resolves a session for private apps. Empty
   *  string for an anonymous visitor on a public one. */
  who: string;
  at: number;
}

interface AppStat {
  since: number;
  paths: Map<string, PathStat>;
  /** Keyed by visitor identity, or by a per-connection token for anonymous ones. */
  here: Map<string, Presence>;
  dropped: number;
}

const apps = new Map<string, AppStat>();

function appStat(slug: string): AppStat {
  const existing = apps.get(slug);
  if (existing) return existing;
  if (apps.size >= MAX_APPS) {
    // Insertion order, so the first key is the least recently created. Evicting
    // costs a stranger walking subdomains our memory rather than ours.
    const oldest = apps.keys().next().value;
    if (oldest !== undefined) apps.delete(oldest);
  }
  const fresh: AppStat = { since: Date.now(), paths: new Map(), here: new Map(), dropped: 0 };
  apps.set(slug, fresh);
  return fresh;
}

/**
 * The part of a URL worth counting.
 *
 * Query strings are dropped: they carry the visitor's own data, and "/search"
 * is the thing an owner wants to see the cost of, not each search anyone ran.
 */
export function pathOf(url: string): string {
  const q = url.indexOf("?");
  const path = (q === -1 ? url : url.slice(0, q)) || "/";
  return path.length > 120 ? path.slice(0, 120) + "…" : path;
}

/** One finished request. Never throws: telemetry must not be able to fail a page. */
export function record(
  slug: string,
  input: { url: string; status: number; ms: number; who: string; anonId: string },
): void {
  try {
    const a = appStat(slug);
    const path = pathOf(input.url);
    let p = a.paths.get(path);
    if (!p) {
      if (a.paths.size >= MAX_PATHS) { a.dropped++; return; }
      p = { hits: 0, broke: 0, missing: 0, ms: [], lastAt: 0, lastBrokeAt: 0, brokeSince: 0 };
      a.paths.set(path, p);
    }
    p.hits++;
    // Three outcomes, not two. `status >= 400` in one bucket meant every app
    // without a favicon led its own list of failures, and no amount of sorting
    // fixes that — the two are different facts about different people.
    if (input.status >= 500) {
      p.broke++;
      p.lastBrokeAt = Date.now();
      if (!p.brokeSince) p.brokeSince = p.lastBrokeAt;
    } else if (input.status >= 400) {
      p.missing++;
    } else {
      p.brokeSince = 0;
    }
    p.ms.push(input.ms);
    if (p.ms.length > SAMPLES) p.ms.shift();
    p.lastAt = Date.now();
    a.here.set(input.who || input.anonId, { who: input.who, at: Date.now() });
  } catch { /* never fail a request over its own measurement */ }
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return Math.round(sorted[i]);
}

export interface XrayPath {
  path: string;
  hits: number;
  /** Requests the app itself failed — 5xx. */
  broke: number;
  /** Requests for something that is not there — 4xx. */
  missing: number;
  p50: number;
  p95: number;
  /** Seconds since this path was last hit. */
  ago: number;
  /**
   * Seconds since the app last failed here. `null` — never `0` — when it never
   * has, because zero seconds ago reads as "it just broke".
   */
  brokeAgo: number | null;
  /**
   * Seconds the app has been failing here with no success in between, or `null`
   * when the last request succeeded. This is the difference between "it broke
   * today" and "it is broken".
   */
  brokenFor: number | null;
}

export interface Xray {
  /** When this process started watching. An empty panel after a release is not
   *  an app with no traffic, and the reader has to be able to tell. */
  since: number;
  here: { count: number; names: string[] };
  paths: XrayPath[];
  /** Paths seen but not tracked, because the app has more than MAX_PATHS. */
  dropped: number;
}

/** Everything the panel shows, for one app, right now. */
export function xray(slug: string): Xray {
  const a = apps.get(slug);
  const now = Date.now();
  if (!a) return { since: now, here: { count: 0, names: [] }, paths: [], dropped: 0 };

  for (const [k, v] of a.here) if (now - v.at > HERE_MS) a.here.delete(k);

  const paths: XrayPath[] = [];
  for (const [path, p] of a.paths) {
    const sorted = [...p.ms].sort((x, y) => x - y);
    paths.push({
      path, hits: p.hits, broke: p.broke, missing: p.missing,
      p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95),
      ago: Math.round((now - p.lastAt) / 1000),
      brokeAgo: p.lastBrokeAt ? Math.round((now - p.lastBrokeAt) / 1000) : null,
      brokenFor: p.brokeSince ? Math.round((now - p.brokeSince) / 1000) : null,
    });
  }
  // Costliest first: an owner opening this wants the thing that is slow, and
  // sorting by hits would bury a 4-second route under the favicon.
  paths.sort((x, y) => y.p95 - x.p95 || y.hits - x.hits);

  const names = [...a.here.values()].map((v) => v.who).filter(Boolean).sort();
  return { since: a.since, here: { count: a.here.size, names }, paths, dropped: a.dropped };
}

/** Test seam. */
export function resetXray(): void { apps.clear(); }
