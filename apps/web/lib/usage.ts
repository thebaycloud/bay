import { getPool } from "./db";
import { getAccount } from "./users";
import { sendApproachingLimit } from "./emails";

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
    const allowed = (r.rowCount ?? 0) > 0;
    // The warning goes HERE because this is the only place a build is counted.
    // Notifying from the deploy route instead would be the mistake this codebase
    // already documents twice — "apply the plan" implemented seven times,
    // `notifyDeployFinished` reading the row rather than being called at each of
    // six endings. A second deploy lane added later would silently warn nobody.
    //
    // Free of extra queries: RETURNING already hands back the new count, so the
    // crossing is known without asking again.
    if (allowed) await warnIfApproaching(userId, meter, limit, Number(r.rows[0]?.[col] ?? 0));
    return allowed;
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

/** Warn at four fifths of the ceiling. Far enough out to act, close enough to be real. */
const WARN_AT = 0.8;

/**
 * Tell somebody they are nearly out of builds, once per period.
 *
 * Before this, the first signal a user got was a 402 in the middle of a deploy —
 * the platform knew for the previous six builds and said nothing.
 *
 * Only on the CROSSING, so the twenty-fifth build of thirty mails and the
 * twenty-sixth does not. The dedupe key is period-scoped anyway, which makes the
 * mail idempotent even if the crossing is somehow computed twice; this check is
 * about not doing the work, not about correctness.
 *
 * Never throws and never blocks the build: a warning is strictly less important
 * than the deploy that triggered it.
 */
async function warnIfApproaching(userId: string, meter: Meter, limit: number, count: number): Promise<void> {
  // Builds only. `agentRuns` on the free plan is zero, so there is no approach to
  // warn about — the first one is already the refusal.
  if (meter !== "builds") return;
  if (!Number.isFinite(limit) || limit <= 0) return;
  const threshold = Math.floor(limit * WARN_AT);
  // The crossing, not the region: `>=` would re-check on every build after it.
  if (count !== threshold) return;
  try {
    const account = await getAccount(userId);
    if (!account?.email) return;
    await sendApproachingLimit({
      userId,
      email: account.email,
      used: count,
      limit,
      // Ceilings are calendar-monthly (see periodStart), so the reset is always
      // the 1st of next month.
      resetsOn: nextPeriodLabel(),
    });
  } catch (e) {
    console.error("approaching-limit mail:", e instanceof Error ? e.message : String(e));
  }
}

/** "September 1" — when this month's counters go back to zero. */
function nextPeriodLabel(now: Date = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return next.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}
