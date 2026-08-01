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
 * Two of the tables read here — `deploys` and `deploy_events` — are created
 * lazily by the code that writes them and appear in no migration, and
 * `platform_admins` arrives in one. Any of them can be missing. Every read
 * therefore degrades to an empty result rather than a failed page: an operators'
 * dashboard that 500s because nobody has deployed yet is worse than one that
 * says so.
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

/** A read whose failure is a missing table, not a broken page. */
async function safeRead<T>(sql: string, params: unknown[] = [], fallback: T[] = []): Promise<T[]> {
  try {
    return await read<T>(sql, params);
  } catch (e) {
    // A genuine mistake in this file must not hide behind the same catch that
    // tolerates a table that does not exist yet.
    if (e instanceof Error && /must be read-only/.test(e.message)) throw e;
    return fallback;
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

export async function users(): Promise<UserRow[]> {
  // `plan` and `status` arrive in migrations 005 and 007; a database that has
  // not had them applied still answers the rest, so they are read defensively.
  const withPlans = await safeRead<{ id: string; email: string; created_at: Date; plan: string | null; status: string | null; provider: string | null }>(
    `SELECT id, email, created_at, plan, status, provider FROM users ORDER BY created_at LIMIT ${ROW_CAP}`,
  );
  if (withPlans.length) return withPlans.map((r) => ({ id: r.id, email: r.email, createdAt: r.created_at, plan: r.plan, status: r.status, provider: r.provider }));

  const bare = await safeRead<{ id: string; email: string; created_at: Date; provider: string | null }>(
    `SELECT id, email, created_at, provider FROM users ORDER BY created_at LIMIT ${ROW_CAP}`,
  );
  return bare.map((r) => ({ id: r.id, email: r.email, createdAt: r.created_at, plan: null, status: null, provider: r.provider }));
}

export interface AppRow {
  slug: string;
  ownerId: string;
  status: string;
  visibility: string;
  createdAt: Date;
}

export async function apps(): Promise<AppRow[]> {
  const rows = await safeRead<{ slug: string; owner_id: string; status: string; visibility: string; created_at: Date }>(
    `SELECT slug, owner_id, status, visibility, created_at FROM apps ORDER BY created_at LIMIT ${ROW_CAP}`,
  );
  return rows.map((r) => ({ slug: r.slug, ownerId: r.owner_id, status: r.status, visibility: r.visibility, createdAt: r.created_at }));
}

/**
 * Stage rows in a window, plus whether the cap cut them off.
 *
 * Ordered by slug then start so the sessionizer's own sort has almost nothing to
 * do, and so a truncated read loses whole apps from the end rather than half a
 * deploy from every app.
 */
export async function stages(w: Window): Promise<{ rows: RawStage[]; truncated: boolean }> {
  const rows = await safeRead<{ slug: string; lane: string; stage: string; started_at: Date; ended_at: Date | null; outcome: StageOutcome | null }>(
    `SELECT slug, lane, stage, started_at, ended_at, outcome
       FROM deploy_stages
      WHERE started_at >= $1 AND started_at <= $2
      ORDER BY slug, started_at
      LIMIT ${ROW_CAP + 1}`,
    [w.from, w.to],
  );
  const truncated = rows.length > ROW_CAP;
  return {
    rows: rows.slice(0, ROW_CAP).map((r) => ({
      slug: r.slug,
      lane: r.lane,
      stage: r.stage,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      outcome: r.outcome,
    })),
    truncated,
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

export async function firstDeploys(): Promise<FirstDeployRow[]> {
  const rows = await safeRead<{ slug: string; first_stage_at: Date; first_success_at: Date | null }>(
    `SELECT slug,
            min(started_at) AS first_stage_at,
            min(ended_at) FILTER (WHERE stage = 'deploy' AND outcome = 'ok') AS first_success_at
       FROM deploy_stages
      GROUP BY slug
      LIMIT ${ROW_CAP}`,
  );
  return rows.map((r) => ({ slug: r.slug, firstStageAt: r.first_stage_at, firstSuccessAt: r.first_success_at }));
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

export async function deployStates(): Promise<DeployStateRow[]> {
  const rows = await safeRead<{ slug: string; owner_id: string | null; status: string; error: string | null; updated_at: Date | null; finished_at: Date | null }>(
    `SELECT slug, owner_id, status, error, updated_at, finished_at FROM deploys LIMIT ${ROW_CAP}`,
  );
  return rows.map((r) => ({
    slug: r.slug,
    ownerId: r.owner_id,
    status: r.status,
    error: r.error,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
  }));
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

export async function errorEvents(w: Window): Promise<ErrorEventRow[]> {
  const rows = await safeRead<{ slug: string; message: string | null; at: Date }>(
    `SELECT slug, event->>'message' AS message, at
       FROM deploy_events
      WHERE at >= $1 AND at <= $2 AND event->>'type' = 'error'
      ORDER BY at
      LIMIT ${ROW_CAP}`,
    [w.from, w.to],
  );
  return rows.filter((r) => r.message).map((r) => ({ slug: r.slug, message: r.message as string, at: r.at }));
}

/**
 * How far back the event log actually goes.
 *
 * Reported rather than assumed: the retention sweep runs opportunistically when
 * a deploy starts, so on a quiet week the log holds more than seven days and on
 * a busy one it holds exactly seven. Either way the page should state the real
 * horizon rather than the intended one.
 */
export async function oldestEventAt(): Promise<Date | null> {
  const rows = await safeRead<{ at: Date | null }>(`SELECT min(at) AS at FROM deploy_events`);
  return rows[0]?.at ?? null;
}

/** Slug to owner, from `apps` first and `deploys` for apps whose row is gone. */
export async function slugOwners(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const d of await deployStates()) if (d.ownerId) out.set(d.slug, d.ownerId);
  // `apps` wins: it is the table ownership is decided from everywhere else.
  for (const a of await apps()) out.set(a.slug, a.ownerId);
  return out;
}
