import { getPool } from "./db";

const DB = "supersonic_platform";

/**
 * How often a thing may happen.
 *
 * Everything else that limits anything here bounds a resource or a month of
 * spend — maxApps, monthlyBuilds, maxConcurrentDeploys, the per-run agent
 * ceilings. This bounds a rate, which is the axis that was missing entirely:
 * signup unlimited, the login path unprotected, and nothing anywhere counting
 * requests.
 *
 * The storage is lib/usage.ts:countIfUnder with a time window in place of a
 * calendar month, deliberately and not by coincidence. That check-and-increment
 * race was solved here once already; solving it a second way would leave two
 * mechanisms to keep correct instead of one.
 */

/**
 * A closed union, not an open string.
 *
 * The scope reaches a query as part of the bucket key and it indexes CEILINGS.
 * `Meter` in lib/usage.ts is closed for the same reason and says so: a
 * caller-supplied name would be an injection.
 */
export type Scope = "signup:ip" | "signup:email-domain" | "login:email-ip";

export type Verdict = { ok: true } | { ok: false; retryAfterSec: number };

export interface Ceiling {
  limit: number;
  windowSec: number;
  /**
   * What a database failure means for THIS scope.
   *
   * Almost everything fails open, mirroring countIfUnder: an outage must not be
   * experienced as "I was refused for no reason". Login is the exception and
   * fails closed, because an outage must not be the thing that opens a
   * brute-force window. The question is always what being wrong costs, and the
   * answer is not symmetric — a few junk accounts on one side, somebody's
   * account on the other.
   */
  failClosed: boolean;
}

/**
 * The ceilings, in one place, the way LIMITS is in lib/entitlements.ts, so the
 * number a route enforces and the number a reader looks up cannot disagree.
 *
 * EVERY NUMBER BELOW IS A GUESS. Nobody has ever counted signups per hour or
 * failed logins per account on this platform. That is precisely why
 * RATE_LIMIT_MODE has a `count` state, and why nothing should reach `enforce`
 * before a week of counting has replaced these with measurements.
 */
export const CEILINGS: Record<Scope, Ceiling> = {
  // Five accounts an hour from one address. A household or a small office
  // behind one NAT could plausibly make three; a farm makes hundreds.
  "signup:ip": { limit: 5, windowSec: 3600, failClosed: false },
  // Twenty an hour from one email domain. Higher than the per-address ceiling
  // on purpose: a real company signing its team up in one afternoon shares a
  // domain and must not be mistaken for a farm. This catches the farm that
  // rotates addresses but keeps one throwaway domain, which the address key
  // would miss completely.
  "signup:email-domain": { limit: 20, windowSec: 3600, failClosed: false },
  // Ten attempts per email+address per fifteen minutes. Somebody who has
  // forgotten which password they used gets several tries; a dictionary does
  // not get a second page.
  "login:email-ip": { limit: 10, windowSec: 900, failClosed: true },
};

/**
 * off | count | enforce.
 *
 * `count` is the state that matters and the reason this is a mode rather than
 * an `*_ENABLED` boolean: it records every take and refuses none of them, so
 * the guesses above can be replaced by measurements before they are ever
 * allowed to turn somebody away. Shipping a guessed ceiling straight to
 * `enforce` is how a limiter locks a real user out on a bad day.
 *
 * Read once at module load, like GATING_ENABLED, so a test must set the
 * variable before its deferred import resolves.
 */
export type Mode = "off" | "count" | "enforce";
let MODE: Mode = (process.env.RATE_LIMIT_MODE as Mode) || "off";

/** Test seam only. Production changes mode by redeploying with a new env var. */
export function setModeForTest(m: Mode): void {
  MODE = m;
}

/**
 * The start of the fixed window this instant falls in.
 *
 * Floor division on epoch milliseconds, so every instance of the control plane
 * derives the same boundary from the clock alone, with nothing shared and no
 * coordination. Two instances disagreeing about which window it is would hand a
 * caller two buckets and twice the ceiling — and the control plane runs up to
 * thirty of them.
 */
export function windowStart(windowSec: number, now: Date = new Date()): Date {
  const ms = windowSec * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

const BOUNDED = `INSERT INTO rate_limits (bucket, window_start, hits)
   VALUES ($1, $2, 1)
   ON CONFLICT (bucket, window_start)
   DO UPDATE SET hits = rate_limits.hits + 1, updated_at = now()
   WHERE rate_limits.hits < $3
   RETURNING hits`;

const UNBOUNDED = `INSERT INTO rate_limits (bucket, window_start, hits)
   VALUES ($1, $2, 1)
   ON CONFLICT (bucket, window_start)
   DO UPDATE SET hits = rate_limits.hits + 1, updated_at = now()
   RETURNING hits`;

export async function takeToken(scope: Scope, key: string): Promise<Verdict> {
  if (MODE === "off") return { ok: true };

  const c = CEILINGS[scope];
  const start = windowStart(c.windowSec);
  const bucket = `${scope}:${key}`;
  const retryAfterSec = Math.max(
    1,
    Math.ceil((start.getTime() + c.windowSec * 1000 - Date.now()) / 1000)
  );

  // In `count` the upsert carries no WHERE, so the counter runs past the
  // ceiling and the observation week learns the real shape of the traffic
  // rather than only the moment it crossed a guess. A bounded counter would
  // report "somebody reached 5" and never "they reached 90", and the distance
  // is the entire number the real ceiling gets chosen from. countIfUnder does
  // the same for unlimited plans, and gives the reason: a plan that records
  // nothing is a plan we cannot price.
  const bounded = MODE === "enforce";

  try {
    const r = await getPool(DB).query(
      bounded ? BOUNDED : UNBOUNDED,
      bounded ? [bucket, start, c.limit] : [bucket, start]
    );

    if (!bounded) {
      const hits = Number((r.rows[0] as { hits?: number } | undefined)?.hits ?? 0);
      if (hits > c.limit) {
        // The whole product of the observation week: what enforcement WOULD
        // have refused, without refusing it. Task 8 of the plan reads these
        // back out of the request log to pick the real ceilings.
        console.warn(`[rate-limit] would refuse ${bucket}: ${hits} > ${c.limit}`);
      }
      return { ok: true };
    }

    return (r.rowCount ?? 0) > 0 ? { ok: true } : { ok: false, retryAfterSec };
  } catch {
    return c.failClosed ? { ok: false, retryAfterSec } : { ok: true };
  }
}

/**
 * Delete windows that can no longer be current.
 *
 * Unlike usage_counters, this table takes a write on every request to a
 * protected route, so nothing about it is self-limiting. One day back is far
 * past the longest window in CEILINGS and still leaves room to read recent
 * history while choosing real ceilings.
 *
 * Swallows its own errors and returns 0. It is called from the domains
 * reconcile job, which does several unrelated things, and limiter housekeeping
 * must not be able to take domain reconciliation down with it.
 */
export async function sweepOldWindows(): Promise<number> {
  try {
    const r = await getPool(DB).query(
      `DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`
    );
    return r.rowCount ?? 0;
  } catch {
    return 0;
  }
}
