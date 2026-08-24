import { getPool } from "./db";

const DB = "supersonic_platform";

/**
 * The durable record of what a deploy did, one row per event.
 *
 * Until now the only copy of a deploy's progress was the SSE stream itself:
 * generated inside the request handler, written straight to the socket, and gone
 * the moment either end went away. So a client that reconnected got nothing, a
 * dashboard opened mid-build got nothing, and a control-plane instance recycled
 * under load took the entire history of an in-flight deploy with it — which is
 * how deploys came to be reported as failed while they were still running.
 *
 * With the events in a table the stream stops being the deploy and becomes a
 * *view* of it: anyone can catch up from event 0 at any time, from any instance,
 * including after the process that produced them is gone.
 */

let ensured: Promise<void> | null = null;
function ensure(): Promise<void> {
  if (!ensured) {
    ensured = getPool(DB).query(
      `CREATE TABLE IF NOT EXISTS deploy_events (
         id      bigserial PRIMARY KEY,
         run_id  text        NOT NULL,
         slug    text        NOT NULL,
         at      timestamptz NOT NULL DEFAULT now(),
         event   jsonb       NOT NULL
       )`
    // Every read is "this run, after this id, in order" — the id is a bigserial so
    // it is already the cursor, and the index makes the tail a range scan rather
    // than a table scan repeated every poll for the length of a build.
    ).then(() => getPool(DB).query(
      `CREATE INDEX IF NOT EXISTS deploy_events_run_id ON deploy_events (run_id, id)`
    )).then(() => getPool(DB).query(
      `CREATE INDEX IF NOT EXISTS deploy_events_at ON deploy_events (at)`
    )).then(() => undefined).catch((e) => { ensured = null; throw e; });
  }
  return ensured;
}

export interface StoredEvent { id: number; event: Record<string, unknown> }

/** Append a batch of events. Best-effort: losing a log line must not fail a deploy. */
async function appendEvents(runId: string, slug: string, events: unknown[]): Promise<void> {
  if (!events.length) return;
  try {
    await ensure();
    // One statement for the batch — a deploy emits a few hundred lines and a
    // round trip each would put the database on the critical path of the build.
    await getPool(DB).query(
      `INSERT INTO deploy_events(run_id, slug, event)
         SELECT $1, $2, e FROM jsonb_array_elements($3::jsonb) AS e`,
      [runId, slug, JSON.stringify(events)],
    );
  } catch { /* ignore — the deploy matters more than its narration */ }
}

/** Events for one run after `afterId`, oldest first. */
export async function readEvents(runId: string, afterId = 0, limit = 500): Promise<StoredEvent[]> {
  try {
    await ensure();
    const r = await getPool(DB).query(
      `SELECT id, event FROM deploy_events
        WHERE run_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
      [runId, afterId, limit],
    );
    return r.rows.map((row: { id: string | number; event: Record<string, unknown> }) => ({
      id: Number(row.id), event: row.event,
    }));
  } catch {
    return [];
  }
}

/**
 * One stored event as a line of log, or null for the ones that are not prose.
 *
 * `detected`, `done` and the rest carry structure a terminal cannot use; only
 * the narration and the failure are worth reading back. The failure is marked
 * with the same ✕ the live stream uses, so a log read after the fact looks like
 * the one that was printed live.
 */
export function eventLine(event: Record<string, unknown>): string | null {
  if (event.type === "log" && typeof event.line === "string") return event.line;
  if (event.type === "error" && typeof event.message === "string") return `✕ ${event.message}`;
  return null;
}

/**
 * The tail of an app's most recent deploy, as text lines.
 *
 * This table was built so the SSE stream could stop being the deploy and become
 * a view of it — but `supersonic logs` never read it, and with the job
 * indirection that left the deploy's narration effectively unreachable: `deploy`
 * returns in about a second, its stream ends with it, and the only channel a
 * user has afterwards showed Cloud Run's container output and a single stage
 * line. Watching y7ux3 fail for 27 minutes on 1 Aug, neither "✕ <error>" nor
 * "Repair agent taking over" ever reached the terminal. Both were emitted.
 *
 * Scoped to the latest run for the slug, because an app redeploys and the
 * previous run's log is not what "why is it doing that right now" means.
 */
export async function readLatestRunLines(slug: string, limit = 200): Promise<Array<{ line: string; at: string }>> {
  try {
    await ensure();
    const r = await getPool(DB).query(
      `SELECT at, event FROM deploy_events
        WHERE run_id = (SELECT run_id FROM deploy_events WHERE slug = $1 ORDER BY id DESC LIMIT 1)
        ORDER BY id DESC LIMIT $2`,
      [slug, limit],
    );
    const out: Array<{ line: string; at: string }> = [];
    // Newest-first from the database so the LIMIT takes the tail rather than the
    // head; flipped back here because a log is read downwards.
    for (const row of r.rows.reverse() as Array<{ at: string | Date; event: Record<string, unknown> }>) {
      const at = row.at instanceof Date ? row.at.toISOString() : String(row.at ?? "");
      const line = eventLine(row.event ?? {});
      if (line !== null) out.push({ line, at });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The patch the repair agent produced on this app's most recent deploy.
 *
 * Kept out of the line-oriented log on purpose. `supersonic logs` prefixes every
 * line with a time and a severity, so a patch printed there cannot be piped into
 * `git apply` — it would be advice that fails the moment somebody types it,
 * which is the same class of bug as the fix never arriving at all.
 */
export async function readLatestPatch(slug: string): Promise<string | null> {
  try {
    await ensure();
    const r = await getPool(DB).query(
      `SELECT event FROM deploy_events
        WHERE slug = $1 AND event->>'type' = 'patch'
        ORDER BY id DESC LIMIT 1`,
      [slug],
    );
    const patch = r.rows[0]?.event?.patch;
    return typeof patch === "string" && patch.trim() ? patch : null;
  } catch {
    return null;
  }
}

/**
 * Drop events older than the retention window.
 *
 * Called opportunistically when a run starts rather than on a schedule: this
 * table is written to on every deploy and read only while one is in flight, so
 * without a sweep it grows forever to store a log nobody will ever open again.
 */
export async function pruneEvents(days = 7): Promise<void> {
  try {
    await ensure();
    await getPool(DB).query(`DELETE FROM deploy_events WHERE at < now() - ($1 || ' days')::interval`, [String(days)]);
  } catch { /* ignore */ }
}

/**
 * An emit() that writes to the event log, buffered.
 *
 * Buffered because the events arrive at the speed of build output — a burst of
 * npm lines is dozens in a few milliseconds — and one INSERT per line would make
 * every deploy as slow as the database is busy. Flushes on a short timer or when
 * the buffer fills, and always on a terminal event: `done` and `error` are the
 * ones a waiting client is actually blocked on, so they are never held back.
 */
export function eventSink(
  runId: string,
  slug: string,
  opts: { intervalMs?: number; maxBatch?: number; append?: (events: unknown[]) => Promise<void> } = {},
) {
  const intervalMs = opts.intervalMs ?? 400;
  const maxBatch = opts.maxBatch ?? 50;
  const append = opts.append ?? ((events: unknown[]) => appendEvents(runId, slug, events));
  let buf: unknown[] = [];
  let timer: NodeJS.Timeout | null = null;
  let chain: Promise<void> = Promise.resolve();

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!buf.length) return chain;
    const batch = buf;
    buf = [];
    // Serialised: batches must land in the order they were emitted, or a reader
    // paging by id would see the log out of order.
    chain = chain.then(() => append(batch));
    return chain;
  };

  return {
    emit(e: unknown) {
      buf.push(e);
      const type = (e as { type?: string } | null)?.type;
      if (type === "done" || type === "error" || buf.length >= maxBatch) { void flush(); return; }
      if (!timer) timer = setTimeout(() => void flush(), intervalMs);
    },
    /** Wait for everything emitted so far to be durable. */
    async drain(): Promise<void> { await flush(); await chain; },
  };
}
