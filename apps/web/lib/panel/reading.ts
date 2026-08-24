/**
 * Everything the panel shows, read a piece at a time.
 *
 * A port of `dwLoad` from services/proxy/panel/layer.js, with two things changed
 * and one kept.
 *
 * Changed: it is same-origin now, so there is no `credentials: "include"` and no
 * CORS rule standing behind it. And the live half comes from the app's own
 * `/_xray`, which is on a DIFFERENT host from this page — the tenant's — so that
 * one call is the only cross-origin read left, and it is the one already allowed.
 *
 * Kept: the per-request deadline. `dwSoon` exists because one of these reaches
 * umami, which reading.ts itself says can be off or unreachable, and the first
 * version waited on Promise.all with no deadline anywhere — leaving the whole
 * panel saying "Reading…" forever with nothing on screen and nothing in the
 * console. A cell holding a dash is worth more than seven cells that never
 * arrive.
 *
 * And now the deadline is per ROW as well as per request. There is no
 * `Promise.all` any more: nine reads start together and each row draws the
 * moment its own read lands. The version this replaces made every cell wait for
 * `/jobs`, which spawns the gcloud CLI — measured at a second with warm
 * credentials — so a share lookup that answered in 40ms showed nothing for a
 * second and a half.
 */

export type Ship = {
  did: string;
  when: string;
  who: string;
  out: string;
  status?: string;
  stage?: string;
  error?: string | null;
  url?: string | null;
};

type Alert = { kind: string; title: string; sub: string; act: string };

export type Reading = {
  slug: string;
  addr: string;
  /** Null when analytics is off, unprovisioned, or unreachable — never zeroes. */
  an: {
    visitors: number;
    views: number;
    mins: string;
    /** Share of sessions that were one page and gone, as a percentage. */
    bounce: string;
    /** Change in visitors against the window before, e.g. "+40%". Empty when
     *  the previous window had nobody in it: percent change from zero is
     *  infinity, and every honest rendering of it is a sentence, not a number. */
    dv: string;
    dvUp: boolean;
    /** Ranked, already trimmed. Empty is an ANSWER — nobody visited a page yet;
     *  the read failing is `an: null`, which the screen says differently. */
    pages: [string, number][];
    from: [string, number][];
  } | null;
  anOn: boolean;
  anReady: boolean;
  here: string[];
  initials: string[];
  tables: [string, number][];
  files: number;
  missing: string | null;
  keys: { name: string; tone: string }[];
  shipping: boolean;
  ships: Ship[];
  live: { path: string; hits: number; p50: number; ago: number; brokenFor?: number }[];
  alert: Alert | null;
};

/** How long ago, in the shortest true form. Defined through dur() so the two
 *  cannot disagree about where an hour ends. */
export function dur(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}
export function ago(sec: number): string {
  return `${dur(sec)} ago`;
}

/** Initials from an address, so a row has something to look at. */
export function ini(x: string): string {
  const n = x.split("@")[0].replace(/[^a-z]/gi, "");
  return (n.slice(0, 2) || "··").toUpperCase();
}

/** A request that cannot hang the panel. Resolves to `fallback` on a deadline. */
function soon<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(fallback);
      }
    }, ms);
    p.then(
      (v) => {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(v);
        }
      },
      () => {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(fallback);
        }
      },
    );
  });
}

type Json = Record<string, any>;

function api(slug: string, path: string): Promise<Json> {
  return fetch(`/api/apps/${encodeURIComponent(slug)}${path}`, {
    headers: { Accept: "application/json" },
  })
    .then((r) => r.json())
    .catch((e) => ({ error: String(e) }));
}

/**
 * Rows out of information_schema come back under names that have changed once
 * already; read them defensively rather than pinning one spelling.
 */
function tableRow(t: Json | string): [string, number] {
  if (typeof t === "string") return [t, 0];
  const name = t.table_name ?? t.tablename ?? t.name ?? String(t);
  const n = t.n_live_tup ?? t.rows ?? 0;
  return [String(name), Number(n) || 0];
}

/**
 * A ranked list from umami, trimmed and made presentable.
 *
 * `x` is null or empty for a direct visit with no referrer, which is most of
 * them for an app somebody shared as a link; it becomes "direct" rather than
 * being dropped, because "where did they come from" with the largest answer
 * missing is worse than useless. A `null` list — umami refused the question —
 * is empty here, and the caller says which it was from `an` being null or not.
 */
export function rank(rows: { x: string | null; y: number }[] | null | undefined, blank: string): [string, number][] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => typeof r?.y === "number" && r.y > 0)
    .slice(0, 6)
    .map((r) => [r.x && String(r.x).trim() ? String(r.x) : blank, Math.round(r.y)] as [string, number]);
}

/**
 * Percent change against the previous window, or "" when there is nothing to
 * compare against. Zero visitors last week and two this week is not "+200%" and
 * not "+0%" — it is a comparison that cannot be drawn, and an empty string is
 * what the tile renders as "—".
 */
export function change(now: number | undefined, prev: number | undefined): string {
  const a = now ?? 0;
  const b = prev ?? 0;
  if (b <= 0) return "";
  const pct = Math.round(((a - b) / b) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

function keyName(k: Json | string): string {
  return typeof k === "string" ? k : String(k.key ?? k.name ?? k);
}

/**
 * Which read a fact came from.
 *
 * Named because a ROW now waits only for its own read. The screen used to be one
 * `Promise.all` over all nine with a six-second deadline apiece, so a cell whose
 * answer arrived in 40ms sat behind `/jobs`, which spawns the gcloud CLI. Nothing
 * appeared until everything had.
 */
export type Part = "env" | "db" | "store" | "dep" | "an" | "live";

/** The raw answers, as they arrive. Absent means "not yet". */
export type Raw = Partial<Record<Part, Json | null>>;

/** What each read is, and how long it is worth waiting for. */
const PARTS: { key: Part; get: (slug: string, addr: string) => Promise<Json | null>; ms: number }[] = [
  { key: "env", get: (s) => api(s, "/env"), ms: 6000 },
  { key: "db", get: (s) => api(s, "/db"), ms: 6000 },
  { key: "store", get: (s) => api(s, "/storage"), ms: 6000 },
  { key: "dep", get: (s) => api(s, "/deploy-status"), ms: 6000 },
  { key: "an", get: (s) => api(s, "/analytics"), ms: 6000 },
  {
    // Shortest deadline and first to be given up on: this is the one that reaches
    // umami, and it is cross-origin to the tenant's own host.
    key: "live",
    ms: 4000,
    get: (_s, addr) =>
      fetch(`https://${addr}/_xray`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      })
        .then((r) => r.json())
        .catch(() => null),
  },
];

/**
 * Start all nine, report each one as it lands.
 *
 * Returns a cancel function, because the screen can be left while six of these
 * are still in flight and a `setState` after that is a React warning at best.
 */
export function readParts(
  slug: string,
  addr: string,
  onPart: (key: Part, value: Json | null) => void,
): () => void {
  let alive = true;
  for (const p of PARTS) {
    soon(p.get(slug, addr), p.ms, null).then((v) => {
      if (alive) onPart(p.key, v);
    });
  }
  return () => {
    alive = false;
  };
}

/**
 * Everything the panel shows, from whatever has arrived so far.
 *
 * Pure, and total: every field has an answer for the case where its read has not
 * landed, so a half-filled screen is a screen with fewer facts on it rather than
 * one that throws. `Reading` is what the rows read; `Raw` is what the network
 * gave us.
 */
export function deriveReading(slug: string, addr: string, raw: Raw): Reading {
  const env = (raw.env ?? {}) as Json;
  const db = (raw.db ?? {}) as Json;
  const store = (raw.store ?? {}) as Json;
  const dep = (raw.dep ?? {}) as Json;
  const an = (raw.an ?? {}) as Json;
  const live = raw.live as Json | null | undefined;

  const paths = live?.live?.paths ?? [];
  const here: string[] = live?.live?.here?.names ?? [];
  const stats = an.stats ?? null;
  const broken = paths.filter((p: Json) => p.brokenFor);

  const d: Reading = {
    slug,
    addr,
    // The COUNT comes from /analytics, which reads umami through the same function
    // chat's `analytics` tool uses. It used to come from the audience half of
    // `/_xray`, so this screen and the chat rail answered one question from two
    // sources — and disagreed on screen, one saying "0 visitors" and the other
    // "could not be reached".
    //
    // The edge counts REQUESTS and umami counts PEOPLE — one page view with eleven
    // assets on it is eleven requests and one visitor. Still never added together.
    an: stats
      ? {
          visitors: stats.visitors,
          views: stats.views,
          mins: String(Math.round((stats.totalTime || 0) / Math.max(stats.visits || 1, 1))),
          // Umami gives bounces and visits, not a returning count. Say what the
          // number is rather than what we wished it were — this tile was fed by
          // a field called `returning` and labelled "bounce", which is two
          // people's worth of confusion for one number.
          bounce: `${Math.round(((stats.bounces || 0) / Math.max(stats.visits || 1, 1)) * 100)}%`,
          // Against the window before this one, which /stats already carries in
          // whichever of its three shapes this umami speaks. It was hardcoded to
          // "" and the tile therefore always read "—", on every app, forever.
          dv: change(stats.visitors, stats.prevVisitors),
          dvUp: (stats.visitors ?? 0) >= (stats.prevVisitors ?? 0),
          // Fetched since the day this screen shipped and thrown away here. The
          // reader asks umami for both lists on every read, so drawing them costs
          // no request that was not already made.
          pages: rank(stats.pages, "/"),
          from: rank(stats.referrers, "direct"),
        }
      : null,
    anOn: an.enabled !== false,
    anReady: Boolean(an.provisioned),
    here,
    initials: here.map(ini),
    tables: (db.tables ?? []).map(tableRow),
    files: (store.objects ?? []).length,
    missing: db.error ?? null,
    keys: (env.keys ?? []).map((k: Json | string) => ({ name: keyName(k), tone: "" })),
    // deploys.ts: status is live | building | deploying | pending | failed |
    // canceled, and there is no 'done'. Reading `stage` for doneness left every
    // finished app saying "Shipping" forever, because stage holds the last step
    // that RAN, not whether it ended.
    shipping: ["building", "deploying", "pending"].includes(String(dep.deploy?.status)),
    ships: [],
    live: paths.slice(0, 40).map((p: Json) => ({
      path: p.path,
      hits: p.hits,
      p50: p.p50,
      ago: p.ago,
      brokenFor: p.brokenFor,
    })),
    alert: null,
  };

  if (dep.deploy) {
    const dd = dep.deploy;
    const st = String(dd.status ?? "");
    const stamp = dd.finishedAt ?? dd.updatedAt;
    d.ships = [
      {
        did: dd.name ?? dd.stage ?? "a change",
        when: stamp ? ago(Math.round((Date.now() - new Date(stamp).getTime()) / 1000)) : "just now",
        // The row records no actor. An owner is the only person who can see this,
        // so naming them is honest; inventing a name would not be.
        who: "you",
        out: st === "live" ? "shipped" : st === "failed" || st === "canceled" ? "never left" : "live",
        status: st,
        stage: dd.stage ?? "",
        error: dd.error ?? null,
        url: dd.url ?? null,
      },
    ];
    if (dd.error) {
      d.alert = {
        kind: "bad",
        title: "The last ship did not land",
        sub: String(dd.error).slice(0, 160),
        act: "Look at it",
      };
    }
  }
  if (!d.ships.length) d.ships = [{ did: "first ship", when: "not yet", who: "you", out: "live" }];

  // A path the edge has seen fail with no success since outranks a failed deploy:
  // one is the app being broken now, the other is a change that never landed.
  if (broken.length) {
    const b = broken[0];
    d.alert = {
      kind: "bad",
      title: `${b.path} has been failing for ${dur(b.brokenFor)}`,
      sub: "The edge has seen no success there since.",
      act: "Look at it",
    };
  }

  return d;
}
