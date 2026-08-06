import { getPool } from "./db";

const DB = "supersonic_platform";

/**
 * The two things a user does that cost us money per occurrence.
 *
 * Deliberately not an open string: the meter name becomes a column name in the
 * upsert below, and a caller-supplied one would be an injection. The map from
 * meter to column is the only place either name is written.
 */
export type Meter = "builds" | "agentRuns";

const COLUMN: Record<Meter, string> = { builds: "builds", agentRuns: "agent_runs" };

export interface Usage {
  periodStart: string;
  builds: number;
  agentRuns: number;
}

/**
 * The first day of the calendar month, UTC, as `YYYY-MM-DD`.
 *
 * UTC rather than local: the server's timezone is not a property anybody
 * chose, and a period boundary that moves with a deploy region would give one
 * user two partial months and another none.
 */
export function periodStart(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

/**
 * Count one event, but only if the user is under `limit` — atomically.
 *
 * Returns whether the event is allowed. The check and the increment are one
 * statement because they cannot be two: five concurrent deploys reading "29 of
 * 30" would all pass a separate check and all increment. The `WHERE` on the
 * `DO UPDATE` is what makes the race impossible — a row that would exceed the
 * limit simply is not updated, and `RETURNING` gives back nothing.
 *
 * Fails OPEN. This mirrors `entitlement()`: a database hiccup must never be
 * experienced as "my deploy was refused for no reason". The cost of letting a
 * few events through during an outage is a few cents; the cost of refusing a
 * paying user's deploy is the account.
 */
export async function countIfUnder(userId: string, meter: Meter, limit: number): Promise<boolean> {
  if (!userId) return true;
  // A zero or negative ceiling is a refusal, not a query. Worth its own branch:
  // the INSERT arm of the upsert below has no WHERE clause to fail, so a limit
  // of 0 would let the very first event of the month through.
  if (limit <= 0) return false;
  const col = COLUMN[meter];
  try {
    if (!Number.isFinite(limit)) {
      // Unlimited plans are still counted. The numbers are the only evidence
      // we will have when the first real ceilings get chosen, and a plan that
      // records nothing is a plan we cannot price.
      await getPool(DB).query(
        `INSERT INTO usage_counters (user_id, period_start, ${col})
         VALUES ($1, $2, 1)
         ON CONFLICT (user_id, period_start)
         DO UPDATE SET ${col} = usage_counters.${col} + 1, updated_at = now()`,
        [userId, periodStart()]
      );
      return true;
    }
    const r = await getPool(DB).query(
      `INSERT INTO usage_counters (user_id, period_start, ${col})
       VALUES ($1, $2, 1)
       ON CONFLICT (user_id, period_start)
       DO UPDATE SET ${col} = usage_counters.${col} + 1, updated_at = now()
       WHERE usage_counters.${col} < $3
       RETURNING ${col}`,
      [userId, periodStart(), limit]
    );
    return (r.rowCount ?? 0) > 0;
  } catch {
    return true;
  }
}

/** This month's counters for a user. Zeroes when nothing has happened yet. */
export async function usageFor(userId: string): Promise<Usage> {
  const empty: Usage = { periodStart: periodStart(), builds: 0, agentRuns: 0 };
  if (!userId) return empty;
  try {
    const r = await getPool(DB).query(
      `SELECT builds, agent_runs FROM usage_counters WHERE user_id = $1 AND period_start = $2`,
      [userId, periodStart()]
    );
    const row = r.rows[0];
    if (!row) return empty;
    return { periodStart: periodStart(), builds: row.builds ?? 0, agentRuns: row.agent_runs ?? 0 };
  } catch {
    return empty;
  }
}

/**
 * Take the one free repair-agent run, if it is still there.
 *
 * Returns true exactly once per user, ever. The `WHERE ... IS NULL` is the
 * whole mechanism: two deploys failing at the same moment both run this, and
 * Postgres serialises them so the second updates zero rows.
 *
 * Fails CLOSED, unlike everything else here — and that asymmetry is deliberate.
 * Every other failure mode costs us a build; this one costs an unbounded LLM
 * session, and a database that cannot tell us whether the grant was already
 * spent is not a database we should spend against. The user still gets the
 * paste-ready prompt, which is the same thing they get on their second failure.
 */
export async function claimFreeFix(userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const r = await getPool(DB).query(
      `UPDATE users SET free_fix_used_at = now()
       WHERE id = $1 AND free_fix_used_at IS NULL
       RETURNING id`,
      [userId]
    );
    return (r.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Whether a user still has their free fix. Read-only — does not claim it. */
export async function freeFixAvailable(userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const r = await getPool(DB).query(`SELECT free_fix_used_at FROM users WHERE id = $1`, [userId]);
    if (!r.rows[0]) return false;
    return r.rows[0].free_fix_used_at === null;
  } catch {
    return false;
  }
}
