import { tailLogs, type LogRow, type Query } from "./logs";

/**
 * One upstream tail per app, fanned out to everyone watching it.
 *
 * `tailEntries` opens a streaming session against Cloud Logging and the API caps
 * how many a project may hold at once. A stream per open browser tab works in
 * development and falls over the first time two people look at the same app, so
 * the tail is keyed by APP and the viewers share it.
 *
 * Which means the upstream tail cannot carry a viewer's filter — two people
 * looking at the same app with different filters would need two streams, and we
 * are back where we started. So it subscribes to EVERYTHING for that app and each
 * viewer's filter is applied here, in memory, by `matches`. The volume that makes
 * this safe is measured: the busiest fleet app produces about 1,073 lines an hour,
 * which is one line every three seconds.
 *
 * Per PROCESS, not per cluster. On Cloud Run each instance keeps its own tails and
 * serves its own viewers, which is correct — a viewer is attached to the instance
 * holding their connection — and it means the cap is per instance rather than
 * shared. Written down because it is the kind of thing that looks like a bug from
 * a metrics graph.
 */

type Sink = (row: LogRow) => void;

interface Hub {
  sinks: Map<number, { sink: Sink; q: Query }>;
  close: () => void;
  /** Set when the upstream stream failed, so a late subscriber is told rather
   *  than left waiting for lines that will never come. */
  broken: string | null;
}

const hubs = new Map<string, Hub>();
let nextId = 1;

/**
 * Does this row satisfy this viewer's filter?
 *
 * A second implementation of the filter, in JavaScript, and that duplication is
 * deliberate and bounded: the upstream stream is unfiltered by design (see above),
 * so somebody has to narrow it. Kept in one exported function and tested against
 * the same cases as `filterFor`, because the failure mode — the tail showing rows
 * the paged read does not, or the reverse — is the kind of inconsistency that
 * makes a log view feel haunted.
 */
export function matches(row: LogRow, q: Query): boolean {
  if (q.sources?.length && !q.sources.includes(row.source)) return false;

  // `frontend` is the browser. `backend` is everything that is neither the
  // browser nor a request — requests have no side at all, which is why they get
  // their own segment rather than being folded into one.
  if (q.face === "frontend" && row.face !== "frontend") return false;
  if (q.face === "backend" && (row.face !== "backend" || row.source === "edge")) return false;

  if (q.minLevel) {
    const rank = { debug: 0, info: 1, warn: 2, error: 3 };
    if (rank[row.level] < rank[q.minLevel]) return false;
  }

  if (q.status && row.http?.status !== q.status) return false;
  // BOTH sides upper-cased. A person types `post` in a filter box, and a method is
  // upper-case by protocol — but comparing a normalised query against an
  // un-normalised row is how this diverged from the server filter, which compares
  // upper-case against what the writer stored. Normalising both means the two can
  // only agree.
  if (q.method && (row.http?.method ?? "").toUpperCase() !== q.method.toUpperCase()) return false;
  if (q.path && !(row.http?.path ?? "").includes(q.path)) return false;

  if (q.search?.trim()) {
    const needle = q.search.trim().toLowerCase();
    const hay = `${row.msg} ${row.http?.path ?? ""} ${row.page?.url ?? ""}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

/**
 * Watch one app. Returns the unsubscribe.
 *
 * The upstream tail is opened on the first subscriber and closed when the last
 * one leaves, so an app nobody is looking at costs nothing.
 */
export function watch(
  slug: string,
  q: Query,
  sink: Sink,
  onBroken: (why: string) => void,
): () => void {
  let hub = hubs.get(slug);

  if (!hub) {
    const sinks = new Map<number, { sink: Sink; q: Query }>();
    const created: Hub = { sinks, close: () => {}, broken: null };
    const stream = tailLogs(
      slug,
      {},
      (row) => {
        for (const { sink: s, q: theirs } of created.sinks.values()) {
          if (matches(row, theirs)) {
            try {
              s(row);
            } catch {
              // One viewer's dead connection must not stop the others' lines.
            }
          }
        }
      },
      (e) => {
        created.broken = e.message;
        // Told, not hidden. A tail that died silently looks exactly like an app
        // that went quiet, and those are opposite facts.
        for (const { sink: s } of created.sinks.values()) {
          try {
            (s as unknown as { broken?: (m: string) => void }).broken?.(e.message);
          } catch { /* gone */ }
        }
      },
    );
    created.close = stream.close;
    hubs.set(slug, created);
    hub = created;
  }

  if (hub.broken) {
    onBroken(hub.broken);
    return () => {};
  }

  const id = nextId++;
  hub.sinks.set(id, { sink, q });

  return () => {
    const h = hubs.get(slug);
    if (!h) return;
    h.sinks.delete(id);
    if (h.sinks.size === 0) {
      h.close();
      hubs.delete(slug);
    }
  };
}

/** For tests, and for a graceful shutdown. */
export function closeAll(): void {
  for (const h of hubs.values()) h.close();
  hubs.clear();
}

export function watching(): number {
  return hubs.size;
}
