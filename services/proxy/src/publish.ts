/**
 * One line per request, published where the log view can find it.
 *
 * THE EDGE ALREADY KNEW ALL OF THIS AND THREW IT AWAY. `xray.ts` keeps sixty
 * paths per app in memory, aggregated, lost on restart — its own docblock says
 * "there is no table, no retention story and no history: this answers what is
 * happening, not what happened". The aggregate stays, because it answers a
 * different question well. This is the other half.
 *
 * WHY STDOUT AND NOT THE LOGGING API
 *
 * The proxy's service account holds `roles/cloudsql.client` and nothing else —
 * checked, not assumed — so a Logging API call would fail with a permission
 * error, per request, forever, and the first anybody would know is an empty
 * Requests tab. Cloud Run already parses a JSON line on stdout into a structured
 * entry: `severity` becomes the severity and every other key becomes
 * `jsonPayload`. So this needs no IAM change, no client library, no batching, no
 * retry, and cannot fail in a way that touches a request. It is a `console.log`.
 *
 * That does put these lines under the PROXY's log name rather than the app's,
 * which is why the reader matches them on `jsonPayload.slug` — see the fourth arm
 * of `filterFor` in apps/web/lib/logs.ts.
 *
 * NO SIDE. A request has no `face`: `GET /dashboard -> 404` is frontend routing
 * and `POST /api/users -> 500` is backend, and the edge cannot tell. It says
 * nothing rather than guessing, which is why Requests is its own segment.
 */

/**
 * How many lines one app may publish per second.
 *
 * The cost of logs is INGEST, and ingest is driven by volume rather than by
 * retention — one app at 100 lines/second is about 260 GiB a month on its own.
 * A ceiling here is the only thing that bounds that, and it is per app so one
 * busy tenant cannot spend everybody's allowance.
 *
 * Dropping is COUNTED and said, not silent. A log view that quietly sampled would
 * be worse than one that admits it skipped 1,204 lines, because the first teaches
 * people the logs are complete when they are not.
 */
const PER_SECOND = Number(process.env.EDGE_LOG_PER_SECOND ?? 20);

/**
 * Read here rather than from `config`.
 *
 * `config.ts` calls `required("AUTH_SECRET")` at import, so importing it makes
 * this module unloadable without a secret — which is how a pure header transform
 * came to need AUTH_SECRET to be unit tested. A switch is one env var; it does
 * not need a config object.
 */
const ON = process.env.PUBLISH_EDGE_LOGS !== "0";

/** Apps tracked. The key space is a public namespace, so it is bounded. */
const MAX_APPS = 500;

interface Budget {
  at: number;
  used: number;
  dropped: number;
}

const budgets = new Map<string, Budget>();

/** Whether this app may publish now, and how many it lost since it last could. */
function allow(slug: string): { ok: boolean; dropped: number } {
  const now = Math.floor(Date.now() / 1000);
  let b = budgets.get(slug);
  if (!b) {
    if (budgets.size >= MAX_APPS) return { ok: false, dropped: 0 };
    b = { at: now, used: 0, dropped: 0 };
    budgets.set(slug, b);
  }
  if (b.at !== now) {
    // A new second. Whatever was dropped in the last one is reported with the
    // first line of this one, so the gap is visible where it happened.
    const dropped = b.dropped;
    b.at = now;
    b.used = 1;
    b.dropped = 0;
    return { ok: true, dropped };
  }
  if (b.used >= PER_SECOND) {
    b.dropped++;
    return { ok: false, dropped: 0 };
  }
  b.used++;
  return { ok: true, dropped: 0 };
}

/** The path, without its query string — which can carry a token or an email. */
export function pathOnly(url: string): string {
  const q = url.indexOf("?");
  const path = q === -1 ? url : url.slice(0, q);
  return path.length > 300 ? `${path.slice(0, 300)}…` : path || "/";
}

/**
 * A request's severity.
 *
 * A 5xx is the app failing and is an error. A 4xx is NOT: a missing favicon is
 * the single most common line any app produces, and colouring it red teaches
 * people to ignore red.
 */
export function severityOf(status: number): "ERROR" | "WARNING" | "INFO" {
  if (status >= 500) return "ERROR";
  if (status >= 400) return "WARNING";
  return "INFO";
}

export function publishRequest(input: {
  slug: string;
  method: string;
  url: string;
  status: number;
  ms: number;
}): void {
  if (!ON) return;
  const slug = (input.slug ?? "").trim();
  if (!slug) return;

  const { ok, dropped } = allow(slug);
  if (!ok) return;

  try {
    if (dropped > 0) {
      process.stdout.write(
        `${JSON.stringify({
          severity: "WARNING",
          slug,
          source: "edge",
          message: `${dropped} request ${dropped === 1 ? "line was" : "lines were"} dropped — this app is publishing more than ${PER_SECOND} a second`,
        })}\n`,
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        severity: severityOf(input.status),
        slug,
        source: "edge",
        method: (input.method || "GET").toUpperCase(),
        path: pathOnly(input.url),
        status: input.status,
        ms: input.ms,
      })}\n`,
    );
  } catch {
    // A log line must never be why a request fails. Nothing to recover, and
    // nowhere useful to report it to.
  }
}

/** For tests. */
export function _resetBudgets(): void {
  budgets.clear();
}
