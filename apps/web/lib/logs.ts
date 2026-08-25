import { Logging } from "@google-cloud/logging";
import { rootDomain } from "./roots";

/**
 * One place that turns "show me this app's logs" into a Cloud Logging filter, and
 * four different entry shapes into one row.
 *
 * WHY CLOUD LOGGING IS THE STORE
 *
 * Because it already is. Both runtimes write there without being asked: a Cloud
 * Run app to `cloud_run_revision` under its service name, and a fleet app to a
 * file that the node's ops agent ships under `gce_instance`. Building a store of
 * our own would mean a Postgres table of lines, a retention job, a compaction
 * story and an index we maintain — to end up with a worse copy of something we
 * already pay for.
 *
 * It also answers the hardest requirement for free. Search runs on Google's
 * index: we forward a filter string and stream rows back, hold no log data, and
 * have no table that somebody's regex can make slow.
 *
 * WHY A CLIENT LIBRARY, when everything else in this codebase spawns `gcloud`
 *
 * Measured: `gcloud logging read` takes 2-4 seconds, almost all of it process
 * spawn and auth. And two things a subprocess cannot do at all — a live tail,
 * which is a bidirectional stream, and page tokens, which are the only way to
 * walk backwards through a log whose head keeps moving. Offset pagination on a
 * live stream repeats and skips lines, which is the defect that makes a log view
 * feel broken in a way nobody can reproduce.
 *
 * THE SCOPING IS THE SECURITY BOUNDARY. `filterFor` composes a caller's search
 * text into an expression that also carries the app restriction. Text that
 * escaped its quotes could close the string, OR in another `logName`, and read
 * another tenant's logs. So the escaping is not a formatting detail — it is the
 * boundary, and it is tested as one. See `quote`.
 */

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "supersonic-deploy-prod";

/**
 * The Cloud Run service the edge runs as.
 *
 * Named here because the fourth filter arm has to be scoped to it: edge lines are
 * claimed by a slug inside the payload, and without also pinning the writer, any
 * tenant printing `{"slug":"someone-else","source":"edge"}` to its own stdout
 * would appear in that app's log view. The slug is the claim; this is the proof
 * of who made it.
 */
const EDGE_SERVICE = process.env.EDGE_SERVICE_NAME || "supersonic-proxy";

/**
 * Where to look: the project, and the ten-year tenant bucket.
 *
 * BOTH, always, and that is not belt-and-braces — it is the only way to see a
 * whole history. `_Default` holds thirty days of everything, including every line
 * written before the tenant bucket existed. The bucket holds tenant lines for ten
 * years, but only from the moment its sink was created. Either one alone has a
 * hole in it, and the hole moves.
 *
 * Safe to ask for both: Cloud Logging deduplicates across resource names.
 * Measured — the same query over `_Default` alone and over both returns the same
 * twenty rows with zero repeated insertIds, not twenty-three.
 *
 * The tenant sink is ADDITIVE: nothing is excluded from `_Default`. Duplicating a
 * tenant line costs about a tenth of a cent a month at today's volume, and it
 * buys a thirty-day safety net for the case where the sink stops routing — which
 * would otherwise lose the logs outright, silently, with the first sign being an
 * empty screen. The exclusion is one command away if volume ever makes it worth
 * the single point of failure.
 */
const TENANT_VIEW =
  process.env.TENANT_LOG_VIEW ??
  `projects/${PROJECT}/locations/global/buckets/bay-tenant-logs/views/_AllLogs`;

function resourceNames(): string[] {
  return TENANT_VIEW ? [`projects/${PROJECT}`, TENANT_VIEW] : [`projects/${PROJECT}`];
}

/** Our own published streams live under one log name per app. */
export function logNameFor(slug: string): string {
  return `bay.app.${slug}`;
}

/** A slug is `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` — no filter metacharacters. */
const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export type Source = "app" | "edge" | "browser" | "build" | "deploy" | "platform";
export type Face = "frontend" | "backend";
export type Level = "debug" | "info" | "warn" | "error";

export const SOURCES: Source[] = ["app", "edge", "browser", "build", "deploy", "platform"];
export const LEVELS: Level[] = ["debug", "info", "warn", "error"];

/** One line, whatever produced it. */
export interface LogRow {
  /** Cloud Logging's insertId — unique, and what a list should key on. */
  id: string;
  /** RFC3339. */
  at: string;
  source: Source;
  /**
   * Which side of the app this came from, or null.
   *
   * NULL ON EDGE REQUESTS, deliberately. `GET /dashboard -> 404` is frontend
   * routing and `POST /api/users -> 500` is backend, and the edge cannot tell
   * them apart — so it says nothing rather than guessing, and the UI gives
   * requests their own segment instead of folding them into a side.
   */
  face: Face | null;
  level: Level;
  msg: string;
  /** `web`, or a worker's name. Derived from the log file for app stdout. */
  process: string | null;
  release: string | null;
  /** Request fields, present when source is `edge`. */
  http: { method: string; path: string; status: number; ms: number } | null;
  /** Browser fields, present when source is `browser`. */
  page: { url: string; line?: number; col?: number; stack?: string } | null;
}

export interface Query {
  /** Restrict to these sources. Empty means all of them. */
  sources?: Source[];
  face?: Face | null;
  /** Minimum level. See `levelOf` — app stdout from a node has none. */
  minLevel?: Level | null;
  /** Free text. Escaped, capped, and never trusted — see `quote`. */
  search?: string | null;
  status?: number | null;
  method?: string | null;
  path?: string | null;
  since?: string | null;
  until?: string | null;
}

/** How long a search string may be. A filter is not a place for an essay. */
const MAX_SEARCH = 200;

/**
 * A string, safe inside a Cloud Logging filter.
 *
 * THE ONE FUNCTION THAT KEEPS ONE TENANT OUT OF ANOTHER'S LOGS. The filter is a
 * single expression carrying both the caller's text and the app restriction, so
 * text that escaped its quotes could close the string, `OR` in another logName,
 * and read somebody else's app.
 *
 * Backslash FIRST. Escaping the quote first would turn an incoming `\"` into
 * `\\"` and leave the quote live — the classic ordering bug in exactly the
 * function that must not have one.
 *
 * Then control characters are REMOVED rather than encoded: they cannot appear in
 * a log message worth searching for, and a newline inside a filter expression is
 * a parse that the API and this function might read differently.
 */
export function quote(raw: string): string {
  const escaped = raw
    .slice(0, MAX_SEARCH)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\x00-\x1f\x7f]/g, "");
  return `"${escaped}"`;
}

const SEVERITY: Record<Level, string> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
};

/**
 * The filter for one app.
 *
 * A union of three homes, because the lines are in three places and always will
 * be: two we do not control, and one we publish to.
 *
 * The node arm anchors on `^/srv/apps/<slug>/` rather than matching a substring.
 * Proven on live data that a substring filter for `subio` also returned
 * `/srv/apps/subio-2/app.log` — one tenant's lines inside another's query.
 */
export function filterFor(slug: string, q: Query = {}): string {
  if (!SLUG.test(slug)) throw new Error(`unsafe slug: ${slug}`);

  const homes = [
    `(resource.type="cloud_run_revision" AND resource.labels.service_name="${slug}")`,
    `(resource.type="gce_instance" AND labels."agent.googleapis.com/log_file_path"=~"^/srv/apps/${slug}/")`,
    `(logName="projects/${PROJECT}/logs/${logNameFor(slug)}")`,
    // The edge. Its lines are written to the PROXY's stdout — its service account
    // has `roles/cloudsql.client` and nothing else, so it cannot call the Logging
    // API, and Cloud Run turns a JSON line into a structured entry for free.
    //
    // THREE conditions, and each one is load-bearing. The service name, so a
    // tenant printing `{"slug":"someone-else"}` on its own stdout cannot inject
    // lines into another app's view — the slug is the claim, this is the proof of
    // who made it. The slug, to pick the app. And `source="edge"`, because the
    // proxy prints plenty of its own diagnostics that happen to carry a slug:
    // without this, `{"needsBody":true,"site":true,"owner":false}` appeared in a
    // tenant's log view as though their app had said it. Seen in production
    // before the third condition existed.
    //
    // `browser` rides the same path: the collector posts to the app's own origin,
    // which is the proxy, so those lines are written by the same process to the
    // same stdout. Deliberately NOT in the tenant sink's filter, which is how
    // browser events get thirty days while everything else gets ten years —
    // retention expressed by which arm a line matches rather than by a second
    // policy somebody has to remember.
    `(resource.type="cloud_run_revision" AND resource.labels.service_name="${EDGE_SERVICE}" AND jsonPayload.slug="${slug}" AND (jsonPayload.source="edge" OR jsonPayload.source="browser"))`,
  ];
  const parts = [`(${homes.join(" OR ")})`];

  // `face` is a stored field, so it can only filter streams that carry one.
  // Requests carry none — see LogRow.face — so asking for a side must not drop
  // them into neither: frontend means browser, backend means everything that is
  // neither browser nor a request.
  if (q.face === "frontend") parts.push(`jsonPayload.face="frontend"`);
  if (q.face === "backend") {
    parts.push(`(jsonPayload.face="backend" OR NOT jsonPayload.face:*)`);
    parts.push(`NOT jsonPayload.source="edge"`);
  }

  if (q.sources?.length) {
    // `app` is the one source with no field of its own: it is whatever arrives
    // from the two runtimes rather than from us, so it is identified by the
    // ABSENCE of ours.
    const arms = q.sources.filter((s) => s !== "app").map((s) => `jsonPayload.source="${s}"`);
    if (q.sources.includes("app")) arms.push(`NOT jsonPayload.source:*`);
    if (arms.length) parts.push(`(${arms.join(" OR ")})`);
  }

  if (q.minLevel) parts.push(`severity>="${SEVERITY[q.minLevel]}"`);
  if (q.status) parts.push(`jsonPayload.status=${Math.trunc(q.status)}`);
  if (q.method) parts.push(`jsonPayload.method=${quote(q.method.toUpperCase())}`);
  if (q.path) parts.push(`jsonPayload.path:${quote(q.path)}`);
  if (q.since) parts.push(`timestamp>=${quote(q.since)}`);
  if (q.until) parts.push(`timestamp<=${quote(q.until)}`);

  // Both payload shapes, because the same word can be in a plain line or in a
  // published one, and a search that looked at only one would answer "not found"
  // about a line already on screen.
  // FOUR fields, because a line's text lives in a different one depending on who
  // wrote it. `textPayload` for a plain Cloud Run line, `jsonPayload.message` for
  // anything the node's ops agent shipped — which is EVERY fleet app's stdout —
  // and `jsonPayload.msg` for what we publish ourselves. Searching only the first
  // three answered "no results" for `listening` while `listening on 8080` was on
  // screen.
  if (q.search?.trim()) {
    const s = quote(q.search.trim());
    parts.push(
      `(textPayload:${s} OR jsonPayload.message:${s} OR jsonPayload.msg:${s} OR jsonPayload.path:${s})`,
    );
  }

  return parts.join(" AND ");
}

/* -------------------------------------------------------------------------- */
/*  Turning what came back into one shape.                                     */
/* -------------------------------------------------------------------------- */

interface RawEntry {
  insertId?: string;
  timestamp?: string | Date | { seconds?: number | string };
  severity?: string | number;
  logName?: string;
  textPayload?: string;
  jsonPayload?: Record<string, unknown>;
  resource?: { type?: string; labels?: Record<string, string> };
  labels?: Record<string, string>;
}

/**
 * Our level, from whatever the entry says.
 *
 * HONEST LIMIT the UI has to know about: lines shipped from a node arrive as
 * severity `DEFAULT`, because the ops agent does not parse levels out of raw
 * stdout. So app stdout on the fleet has no level, and "errors only" cannot work
 * on it. Reported as `info` rather than invented, and the screen disables that
 * filter for that source with the reason rather than offering one that silently
 * matches nothing.
 */
function levelOf(severity: RawEntry["severity"]): Level {
  const s = String(severity ?? "").toUpperCase();
  if (s === "ERROR" || s === "CRITICAL" || s === "ALERT" || s === "EMERGENCY") return "error";
  if (s === "WARNING") return "warn";
  if (s === "DEBUG") return "debug";
  return "info";
}

/** `/srv/apps/shop/worker.log` is the `worker` process; `app.log` is the web one. */
function processOf(path: string | undefined): string | null {
  if (!path) return null;
  const file = path.slice(path.lastIndexOf("/") + 1).replace(/\.log$/, "");
  return file === "app" ? "web" : file || null;
}

/**
 * The node's account of what it did to an app.
 *
 * Named by the FILE, not by a field, and that is the whole trick. The ops agent
 * already ships every `.log` under `/srv/apps/<slug>/` and the node arm of the
 * filter already
 * anchors on that slug, so the fleet agent writing `platform.log` beside `app.log`
 * gets its lines labelled with the right app through plumbing that exists —
 * no config change on the node, no new permission, no second pipeline.
 *
 * The trade is that the payload arrives as text rather than parsed, so the source
 * is derived here instead of read from a field.
 */
function isPlatformFile(path: string | undefined): boolean {
  return Boolean(path && path.endsWith("/platform.log"));
}

function timeOf(t: RawEntry["timestamp"]): string {
  if (!t) return "";
  if (typeof t === "string") return t;
  if (t instanceof Date) return t.toISOString();
  const sec = Number((t as { seconds?: number | string }).seconds ?? 0);
  return sec ? new Date(sec * 1000).toISOString() : "";
}

/**
 * A protobuf Value/Struct as a plain JavaScript value.
 *
 * `getEntries` hands back an `Entry` whose `.data` is already decoded, but the
 * TAIL stream does not — its entries arrive as raw protos, where a payload reads
 * `{"fields":{"message":{"stringValue":"listening on 8080","kind":"stringValue"}}}`.
 * Without this, every tailed line's message was that JSON blob instead of the
 * line. Found by running it, not by reading the types, which describe both as
 * `Record<string, unknown>`.
 */
function plain(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if ("stringValue" in o) return o.stringValue;
  if ("numberValue" in o) return o.numberValue;
  if ("boolValue" in o) return o.boolValue;
  if ("nullValue" in o) return null;
  if ("structValue" in o) return plain(o.structValue);
  if ("listValue" in o) return plain(o.listValue);
  if ("values" in o && Array.isArray(o.values)) return o.values.map(plain);
  if ("fields" in o && o.fields && typeof o.fields === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o.fields as Record<string, unknown>)) out[k] = plain(val);
    return out;
  }
  return v;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * The client library's own announcement of itself.
 *
 * `@google-cloud/logging` writes one `logging.googleapis.com/diagnostic` entry
 * naming its version into the same log we publish to. It is our plumbing talking
 * about our plumbing, and without this it appears in a tenant's log view as a
 * line they did not write and cannot explain.
 *
 * Dropped at read time rather than excluded in the query: the field name contains
 * dots and a slash, so keeping it out of a filter expression is a quoting problem,
 * and this is one comparison on a payload we already hold.
 */
export function isLibraryNoise(payload: unknown): boolean {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      "logging.googleapis.com/diagnostic" in (payload as Record<string, unknown>),
  );
}

/**
 * One entry, as a row.
 *
 * `decoded` is `Entry.data` from the paged reader, which the library has already
 * turned into a plain object. The tail has no such thing, so an undecoded Struct
 * on `jsonPayload` is run through `plain` instead.
 */
export function normalise(e: RawEntry, decoded?: unknown): LogRow {
  const j = ((decoded && typeof decoded === "object" ? decoded : plain(e.jsonPayload)) ??
    {}) as Record<string, unknown>;
  const filePath = e.labels?.["agent.googleapis.com/log_file_path"];
  const ours = str(j.source) as Source | null;
  const source: Source =
    ours && SOURCES.includes(ours) ? ours : isPlatformFile(filePath) ? "platform" : "app";

  // PRESENCE, not truthiness. `str()` treats "" as absent, so a blank line — of
  // which npm prints plenty — fell through to the JSON blob and rendered as
  // `{"message":""}`. An empty log line is an empty log line.
  const text = [j.msg, e.textPayload, j.message].find((v) => typeof v === "string") as
    | string
    | undefined;
  let msg = text ?? (Object.keys(j).length ? JSON.stringify(j) : "");
  let noted: { level?: string; msg?: string } | null = null;

  // The node writes JSON into platform.log; the ops agent ships files as text and
  // parses nothing, so what arrives is the JSON as a string. Unwrapped here —
  // once, for the one file we know does this — rather than shown to somebody as
  // a line of braces.
  if (isPlatformFile(filePath) && msg.startsWith("{")) {
    try {
      const o = JSON.parse(msg) as { level?: string; msg?: string };
      if (typeof o.msg === "string") { noted = o; msg = o.msg; }
    } catch {
      // Not ours, or half-written by a node that died mid-line. Shown as it is.
    }
  }

  const face = str(j.face);
  const status = num(j.status);

  return {
    // insertId, because timestamps COLLIDE: a burst writes many lines in the same
    // millisecond, and keying a list on time makes React reuse the wrong row.
    id: str(e.insertId) ?? `${timeOf(e.timestamp)}:${msg.slice(0, 40)}`,
    at: timeOf(e.timestamp),
    source,
    face: face === "frontend" || face === "backend" ? face : source === "app" ? "backend" : null,
    // The node's own word for it when it said one: these lines arrive as
    // severity DEFAULT like everything else from a file, so without this a
    // platform error would read as info.
    level: (noted?.level && (LEVELS as string[]).includes(noted.level)
      ? (noted.level as Level)
      : levelOf(e.severity)),
    msg: msg.length > 4000 ? `${msg.slice(0, 4000)}…` : msg,
    process: str(j.process) ?? processOf(filePath),
    release: str(j.release),
    http:
      source === "edge" && status !== null
        ? { method: str(j.method) ?? "GET", path: str(j.path) ?? "/", status, ms: num(j.ms) ?? 0 }
        : null,
    page:
      source === "browser"
        ? {
            url: str(j.url) ?? "",
            line: num(j.line) ?? undefined,
            col: num(j.col) ?? undefined,
            stack: str(j.stack) ?? undefined,
          }
        : null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Reading.                                                                   */
/* -------------------------------------------------------------------------- */

let client: Logging | null = null;
function logging(): Logging {
  client ??= new Logging({ projectId: PROJECT });
  return client;
}

export const MAX_PAGE = 200;
export const DEFAULT_PAGE = 100;

/**
 * How far back the first page looks, when nothing says otherwise.
 *
 * There has to be a bound, and it has to be OURS. `getEntries` silently appends
 * `AND timestamp >= <24h ago>` when the filter carries no timestamp clause —
 * measured, not read in a doc — so leaving it out does not mean "everything", it
 * means a day, chosen by the library, invisibly. Which would have quietly capped
 * the retention we just decided to make unlimited.
 *
 * Seven days because it is fast and covers the question people arrive with. The
 * UI can widen it, and `ALL_SINCE` means the whole retention.
 */
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const ALL_SINCE = "2020-01-01T00:00:00Z";

export interface Page {
  rows: LogRow[];
  /** Opaque. Pass back as `cursor` for the next page; null when there is no more. */
  cursor: string | null;
  /** The window this page was read over, so the UI can say what it is showing. */
  since: string;
}

/**
 * The cursor: a page token AND the window it was minted against.
 *
 * Both, because a Cloud Logging page token is only valid for a byte-identical
 * request. Rebuilding the filter with a different timestamp bound gets
 * `page_token doesn't match arguments from the request` — which is what happened
 * the first time this ran, since the bound was being generated fresh per call.
 *
 * Not signed, and it does not need to be: it carries a token that is opaque to
 * the client and validated by Google against the filter WE build, plus a
 * timestamp the caller could already have passed as `since`. Tampering widens or
 * narrows their own window and reaches nothing else. The slug is never in here —
 * it comes from the route, which has already checked ownership.
 */
function packCursor(token: string, since: string): string {
  return Buffer.from(JSON.stringify({ t: token, s: since })).toString("base64url");
}

function unpackCursor(cursor: string): { token: string; since: string } | null {
  try {
    const o = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return typeof o?.t === "string" && typeof o?.s === "string" ? { token: o.t, since: o.s } : null;
  } catch {
    return null;
  }
}

/**
 * One page, newest first.
 *
 * A PAGE TOKEN and not an offset. New lines arrive while somebody reads, so an
 * offset means page two starts partway through page one — lines repeat, lines
 * vanish, and the list is broken in a way nobody can reproduce. Verified against
 * production: consecutive pages share zero rows.
 */
export async function readLogs(
  slug: string,
  q: Query = {},
  opts: { limit?: number; cursor?: string | null } = {},
): Promise<Page> {
  const pageSize = Math.min(Math.max(opts.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
  const from = opts.cursor ? unpackCursor(opts.cursor) : null;
  const since = from?.since ?? q.since ?? new Date(Date.now() - DEFAULT_WINDOW_MS).toISOString();

  // The bound goes in the filter WE build, so the library adds nothing and the
  // token stays valid across pages.
  const filter = filterFor(slug, { ...q, since });

  const [entries, next] = (await logging().getEntries({
    filter,
    resourceNames: resourceNames(),
    orderBy: "timestamp desc",
    pageSize,
    autoPaginate: false,
    ...(from ? { pageToken: from.token } : {}),
  })) as unknown as [{ metadata: RawEntry; data?: unknown }[], { pageToken?: string } | null];

  return {
    rows: entries.filter((x) => !isLibraryNoise(x.data)).map((x) => normalise(x.metadata, x.data)),
    cursor: next?.pageToken ? packCursor(next.pageToken, since) : null,
    since,
  };
}

/**
 * Every new line for one app, until stopped.
 *
 * ONE TAIL PER APP, never one per viewer. `tailEntries` opens a streaming session
 * and the API caps how many a project may hold at once, so a tail per open tab
 * would work in development and fail under any real load. The caller fans one
 * stream out to that app's watchers — see the SSE route.
 */
export function tailLogs(
  slug: string,
  q: Query,
  onRow: (row: LogRow) => void,
  onError: (e: Error) => void,
): { close: () => void } {
  // No timestamp bound: a tail is about what happens next, and a `since` in the
  // past would make the API replay history into a live stream.
  const { since: _drop, until: _drop2, ...live } = q;
  const stream = logging().tailEntries({
    filter: filterFor(slug, live),
    resourceNames: resourceNames(),
  });

  // The tail hands back the same `{ metadata, data }` wrapper the paged reader
  // does, with `data` already decoded — not the raw entry the types suggest.
  // Passing the wrapper in as the entry made every tailed line blank and
  // classified all of them as app stdout.
  stream.on("data", (res: { entries?: { metadata: RawEntry; data?: unknown }[] }) => {
    for (const e of res.entries ?? []) {
      if (isLibraryNoise(e.data)) continue;
      onRow(normalise(e.metadata, e.data));
    }
  });
  stream.on("error", (e: Error) => onError(e));

  return {
    close: () => {
      try {
        stream.end();
        stream.removeAllListeners();
      } catch {
        // Already gone. The point was to stop reading, and it has stopped.
      }
    },
  };
}

/** For the empty state, which says "nothing since", never "no logs". */
export function appAddress(slug: string): string {
  return `${slug}.${rootDomain()}`;
}

/* ------------------------------------------------------------- error sweep */

/**
 * Errors across EVERY app in a window, grouped by app.
 *
 * Everything else here is scoped to one slug, because everything else is
 * answering "show me this app". The error email asks the opposite question —
 * which apps are broken right now — and asking it one app at a time is a
 * subprocess or an API round trip per app on a timer, which is how a sweep
 * becomes the most expensive thing the platform does.
 *
 * So: one query. The cost is that the slug has to be recovered from the entry
 * rather than supplied to the filter, and it lives in a different place for each
 * runtime — the ops-agent file path for a fleet app, our own log name for
 * anything we publish, the service name on Cloud Run. `slugOf` handles the three.
 *
 * OUR OWN SERVICES ARE EXCLUDED, and that is the arm most likely to rot: every
 * platform service is `supersonic-*`, so a future one named otherwise would start
 * mailing its errors to whichever tenant shares its name. Hence the belt of the
 * prefix test in `slugOf` as well as the filter's own exclusion.
 */
export interface AppErrorBurst {
  slug: string;
  count: number;
  /** The most recent one, already trimmed to something an email can carry. */
  newest: string;
  newestAt: string;
}

/** Which app produced an entry, or null when it is one of ours. */
function slugOf(e: RawEntry): string | null {
  const path = (e as { labels?: Record<string, string> }).labels?.["agent.googleapis.com/log_file_path"];
  const fromPath = typeof path === "string" ? /^\/srv\/apps\/([a-z0-9][a-z0-9-]*)\//.exec(path)?.[1] : null;
  if (fromPath) return fromPath;

  const logName = typeof e.logName === "string" ? e.logName : "";
  const fromLog = /\/logs\/bay\.app\.([a-z0-9][a-z0-9-]*)$/.exec(decodeURIComponent(logName))?.[1];
  if (fromLog) return fromLog;

  const svc = (e as { resource?: { labels?: Record<string, string> } }).resource?.labels?.service_name;
  // A platform service is never a tenant. The filter excludes these too; this is
  // the check that survives somebody editing the filter.
  if (typeof svc === "string" && svc && !svc.startsWith("supersonic-") && SLUG.test(svc)) return svc;
  return null;
}

/**
 * Read one window's errors and fold them per app.
 *
 * `since` is always supplied, never left to the library — `getEntries` silently
 * appends its own 24-hour bound when a filter carries no timestamp clause, which
 * for a sweep on a schedule would mean quietly reporting a day of errors as an
 * hour of them.
 */
export async function errorsByApp(sinceIso: string, opts: { max?: number } = {}): Promise<AppErrorBurst[]> {
  const max = Math.min(Math.max(opts.max ?? 500, 1), 1000);
  const filter = [
    `severity>="ERROR"`,
    `timestamp>=${quote(sinceIso)}`,
    `(`,
    [
      `(resource.type="gce_instance" AND labels."agent.googleapis.com/log_file_path"=~"^/srv/apps/")`,
      `(logName=~"projects/${PROJECT}/logs/bay\\.app\\..*")`,
      `(resource.type="cloud_run_revision" AND NOT resource.labels.service_name=~"^supersonic-")`,
    ].join(" OR "),
    `)`,
  ].join(" ");

  const [entries] = (await logging().getEntries({
    filter,
    resourceNames: resourceNames(),
    orderBy: "timestamp desc",
    pageSize: max,
    autoPaginate: false,
  })) as unknown as [{ metadata: RawEntry; data?: unknown }[], unknown];

  const byApp = new Map<string, AppErrorBurst>();
  for (const x of entries) {
    if (isLibraryNoise(x.data)) continue;
    const slug = slugOf(x.metadata);
    if (!slug) continue;
    const row = normalise(x.metadata, x.data);
    const seen = byApp.get(slug);
    if (seen) {
      seen.count += 1;
      continue;
    }
    // Entries arrive newest-first, so the first one per app IS the newest.
    byApp.set(slug, { slug, count: 1, newest: row.msg.slice(0, 1200), newestAt: row.at });
  }
  return [...byApp.values()].sort((a, b) => b.count - a.count);
}
