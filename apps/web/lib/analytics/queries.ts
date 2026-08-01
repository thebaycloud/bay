import { getPool } from "../db";
import type { RawStage, StageOutcome } from "./attempts";

const DB = "supersonic_platform";

/**
 * Everything the analytics page reads out of production, and nothing it writes.
 *
 * The database is shared production, so read-only here is not a convention —
 * it is enforced twice. Every statement runs inside `BEGIN READ ONLY`, which
 * makes Postgres itself reject a write whatever the SQL says, and every
 * statement is checked against `assertReadOnly` before it is sent, so a mistake
 * fails in review rather than at a transaction boundary. The transaction is the
 * guarantee; the guard is there to make the mistake obvious.
 *
 * A READ THAT FAILS SAYS SO
 *
 * These reads used to return an empty array on any error. That made a broken
 * query indistinguishable from a quiet week — on a page whose entire job is to
 * be believed, and against tables whose column names were read off `lib/*.ts`
 * rather than a migration, because `deploys` and `deploy_events` are created by
 * the code that writes them and appear in no migration at all.
 *
 * So every read returns its rows AND the database's own words when it fails.
 * The page keeps rendering — one broken panel must not take the others down
 * with it — but the broken panel says what broke. "column deploys.finished_at
 * does not exist" is worth more than a clean-looking empty box.
 */

/** Statement keywords that have no business in this file. */
const FORBIDDEN = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|merge|vacuum|refresh|comment|set\s+(?!transaction))\b/i;

export function assertReadOnly(sql: string): void {
  // Strip string literals and comments first: a WHERE clause may legitimately
  // match on the word "delete" in a stored error message.
  const bare = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, " ")
    .replace(/"(?:[^"]|"")*"/g, " ");
  const hit = bare.match(FORBIDDEN);
  if (hit) throw new Error(`analytics queries must be read-only; found "${hit[0]}"`);
}

/** Rows, and — when there are none because the read broke — why. */
export interface Read<T> {
  rows: T[];
  /** The database's own message. Null when the read succeeded. */
  error: string | null;
}

/**
 * Run one statement in a read-only transaction.
 *
 * The connection is taken from the pool and always returned, including when the
 * query throws — a leaked client on a control plane with `max: 3` takes a third
 * of production's database capacity with it.
 */
async function read<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  assertReadOnly(sql);
  const client = await getPool(DB).connect();
  try {
    await client.query("BEGIN READ ONLY");
    const r = await client.query(sql, params);
    await client.query("COMMIT");
    return r.rows as T[];
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * The message an operator sees for a failed read.
 *
 * Postgres says things like `column "finished_at" does not exist`, which names
 * the defect precisely, so it is passed through rather than replaced by
 * something friendlier. First line only: a stack trace on the page helps nobody
 * and the rest is in the log.
 */
export function readErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const first = raw.split("\n")[0].trim();
  return first || "the read failed without saying why";
}

/** A read whose failure becomes a visible panel rather than an empty one. */
async function attempt<T>(sql: string, params: unknown[] = []): Promise<Read<T>> {
  try {
    return { rows: await read<T>(sql, params), error: null };
  } catch (e) {
    // Logged as well as rendered: the page shows one line, the log keeps the rest.
    console.error("analytics read failed", e);
    return { rows: [], error: readErrorMessage(e) };
  }
}

export interface Window {
  from: Date;
  to: Date;
  days: number;
}

export function windowOf(days: number, now: Date = new Date()): Window {
  const to = now;
  const from = new Date(now.getTime() - days * 86_400_000);
  return { from, to, days };
}

/**
 * How many rows any one query may return.
 *
 * A cap rather than pagination because this page summarises; what matters is
 * that it says so when it hits one, rather than quietly reporting a percentile
 * over the first 200,000 of something.
 */
export const ROW_CAP = 200_000;

export interface UserRow {
  id: string;
  email: string;
  createdAt: Date;
  plan: string | null;
  status: string | null;
  provider: string | null;
}

export async function users(): Promise<Read<UserRow>> {
  // `plan` and `status` arrive in migrations 005 and 007. A database that has
  // not had them applied still answers the rest, so a narrower read is tried
  // second — and if BOTH fail, the second failure is the one reported, because
  // that is the one meaning the users table itself cannot be read.
  const full = await attempt<{ id: string; email: string; created_at: Date; plan: string | null; status: string | null; provider: string | null }>(
    `SELECT id, email, created_at, plan, status, provider FROM users ORDER BY created_at LIMIT ${ROW_CAP}`,
  );
  if (!full.error) {
    return {
      rows: full.rows.map((r) => ({ id: r.id, email: r.email, createdAt: r.created_at, plan: r.plan, status: r.status, provider: r.provider })),
      error: null,
    };
  }

  const bare = await attempt<{ id: string; email: string; created_at: Date; provider: string | null }>(
    `SELECT id, email, created_at, provider FROM users ORDER BY created_at LIMIT ${ROW_CAP}`,
  );
  return {
    rows: bare.rows.map((r) => ({ id: r.id, email: r.email, createdAt: r.created_at, plan: null, status: null, provider: r.provider })),
    error: bare.error,
  };
}

export interface AppRow {
  slug: string;
  ownerId: string;
  status: string;
  visibility: string;
  createdAt: Date;
}

export async function apps(): Promise<Read<AppRow>> {
  const r = await attempt<{ slug: string; owner_id: string; status: string; visibility: string; created_at: Date }>(
    `SELECT slug, owner_id, status, visibility, created_at FROM apps ORDER BY created_at LIMIT ${ROW_CAP}`,
  );
  return {
    rows: r.rows.map((x) => ({ slug: x.slug, ownerId: x.owner_id, status: x.status, visibility: x.visibility, createdAt: x.created_at })),
    error: r.error,
  };
}

/**
 * Stage rows in a window, plus whether the cap cut them off.
 *
 * Ordered by slug then start so the sessionizer's own sort has almost nothing to
 * do, and so a truncated read loses whole apps from the end rather than half a
 * deploy from every app.
 */
export async function stages(w: Window): Promise<Read<RawStage> & { truncated: boolean }> {
  const r = await attempt<{ slug: string; lane: string; stage: string; started_at: Date; ended_at: Date | null; outcome: StageOutcome | null }>(
    `SELECT slug, lane, stage, started_at, ended_at, outcome
       FROM deploy_stages
      WHERE started_at >= $1 AND started_at <= $2
      ORDER BY slug, started_at
      LIMIT ${ROW_CAP + 1}`,
    [w.from, w.to],
  );
  const truncated = r.rows.length > ROW_CAP;
  return {
    rows: r.rows.slice(0, ROW_CAP).map((x) => ({
      slug: x.slug,
      lane: x.lane,
      stage: x.stage,
      startedAt: x.started_at,
      endedAt: x.ended_at,
      outcome: x.outcome,
    })),
    truncated,
    error: r.error,
  };
}

/**
 * The earliest recorded stage for every app, whatever the window.
 *
 * Time-to-first-success is measured from signup, which can be months before the
 * window starts, so it cannot be answered from a windowed read.
 */
export interface FirstDeployRow {
  slug: string;
  firstStageAt: Date;
  firstSuccessAt: Date | null;
}

export async function firstDeploys(): Promise<Read<FirstDeployRow>> {
  const r = await attempt<{ slug: string; first_stage_at: Date; first_success_at: Date | null }>(
    `SELECT slug,
            min(started_at) AS first_stage_at,
            min(ended_at) FILTER (WHERE stage = 'deploy' AND outcome = 'ok') AS first_success_at
       FROM deploy_stages
      GROUP BY slug
      LIMIT ${ROW_CAP}`,
  );
  return {
    rows: r.rows.map((x) => ({ slug: x.slug, firstStageAt: x.first_stage_at, firstSuccessAt: x.first_success_at })),
    error: r.error,
  };
}

/**
 * The latest deploy record per app: status, the reason it failed, and who owns it.
 *
 * `deploys` holds ONE row per slug, upserted — it is the current state of an
 * app, not a history. So this answers "what went wrong last time" for each app
 * and can never answer "how often does that go wrong".
 */
export interface DeployStateRow {
  slug: string;
  ownerId: string | null;
  status: string;
  error: string | null;
  updatedAt: Date | null;
  finishedAt: Date | null;
}

export async function deployStates(): Promise<Read<DeployStateRow>> {
  const r = await attempt<{ slug: string; owner_id: string | null; status: string; error: string | null; updated_at: Date | null; finished_at: Date | null }>(
    `SELECT slug, owner_id, status, error, updated_at, finished_at FROM deploys LIMIT ${ROW_CAP}`,
  );
  return {
    rows: r.rows.map((x) => ({
      slug: x.slug,
      ownerId: x.owner_id,
      status: x.status,
      error: x.error,
      updatedAt: x.updated_at,
      finishedAt: x.finished_at,
    })),
    error: r.error,
  };
}

/**
 * Error events in the window.
 *
 * The one source that records a reason PER DEPLOY rather than per app — but
 * `pruneEvents` drops anything older than 7 days, so a window wider than a week
 * is answered by a table that has already forgotten most of it. The page says so
 * next to the number.
 */
export const EVENT_RETENTION_DAYS = 7;

export interface ErrorEventRow {
  slug: string;
  message: string;
  at: Date;
}

export async function errorEvents(w: Window): Promise<Read<ErrorEventRow>> {
  const r = await attempt<{ slug: string; message: string | null; at: Date }>(
    `SELECT slug, event->>'message' AS message, at
       FROM deploy_events
      WHERE at >= $1 AND at <= $2 AND event->>'type' = 'error'
      ORDER BY at
      LIMIT ${ROW_CAP}`,
    [w.from, w.to],
  );
  return {
    rows: r.rows.filter((x) => x.message).map((x) => ({ slug: x.slug, message: x.message as string, at: x.at })),
    error: r.error,
  };
}

/**
 * How far back the event log actually goes.
 *
 * Reported rather than assumed: the retention sweep runs opportunistically when
 * a deploy starts, so on a quiet week the log holds more than seven days and on
 * a busy one it holds exactly seven. Either way the page should state the real
 * horizon rather than the intended one.
 */
export async function oldestEventAt(): Promise<{ at: Date | null; error: string | null }> {
  const r = await attempt<{ at: Date | null }>(`SELECT min(at) AS at FROM deploy_events`);
  return { at: r.rows[0]?.at ?? null, error: r.error };
}
