import { test, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * The limiter, against a driver that is not a database.
 *
 * `getPool` points at 127.0.0.1:5433, so a test that reached a real pool would
 * quietly write production on any machine with cloud-sql-proxy running. Same
 * reasoning as test/plan-limits.test.ts, and the same mock.
 *
 * RATE_LIMIT_MODE is set BEFORE the deferred import, because lib/rate-limit
 * reads it once at module load. Left unset, every take below would return
 * `{ ok: true }` without touching the mock and every assertion would pass while
 * testing nothing.
 */
process.env.RATE_LIMIT_MODE = "enforce";

type Result = { rows: unknown[]; rowCount: number };
type Handler = (sql: string, params: unknown[]) => Result;

let handler: Handler = () => ({ rows: [{ hits: 1 }], rowCount: 1 });
let queryThrows: Error | null = null;
const sent: { sql: string; params: unknown[] }[] = [];

mock.module("@/lib/db", {
  namedExports: {
    getPool: () => ({
      query: async (sql: string, params: unknown[] = []) => {
        if (queryThrows) throw queryThrows;
        sent.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
        return handler(sql, params);
      },
    }),
  },
});

function withDb(h: Handler, throws: Error | null = null): void {
  handler = h;
  queryThrows = throws;
  sent.length = 0;
}

// Deferred, not static: tsx compiles these to CJS, where a static import is
// hoisted above `mock.module` and would load the real lib/db.
const rl$ = import("@/lib/rate-limit");

// ------------------------------------------------------------ taking a token

test("a take under the ceiling is allowed", async () => {
  const { takeToken } = await rl$;
  withDb(() => ({ rows: [{ hits: 3 }], rowCount: 1 }));
  assert.deepEqual(await takeToken("signup:ip", "203.0.113.1"), { ok: true });
});

test("the ceiling is enforced by the statement, not by a read-then-write", async () => {
  const { takeToken } = await rl$;
  // An empty RETURNING is how the database says "the WHERE on DO UPDATE did not
  // match". Two statements here would let concurrent callers all read 9 of 10
  // and all pass -- the exact race lib/usage.ts:countIfUnder was written to
  // avoid. This asserts we inherited the fix and not merely the shape.
  withDb(() => ({ rows: [], rowCount: 0 }));
  const v = await takeToken("signup:ip", "203.0.113.1");
  assert.equal(v.ok, false);
  const sql = sent[0].sql;
  assert.match(sql, /ON CONFLICT/);
  assert.match(sql, /WHERE rate_limits\.hits < \$3/);
  assert.match(sql, /RETURNING/);
});

test("a refusal says when to come back", async () => {
  const { takeToken, CEILINGS } = await rl$;
  withDb(() => ({ rows: [], rowCount: 0 }));
  const v = await takeToken("login:email-ip", "a@b.com|203.0.113.1");
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.ok(v.retryAfterSec > 0);
  assert.ok(v.retryAfterSec <= CEILINGS["login:email-ip"].windowSec);
});

test("the bucket key is the scope and the key together", async () => {
  const { takeToken } = await rl$;
  withDb(() => ({ rows: [{ hits: 1 }], rowCount: 1 }));
  await takeToken("signup:ip", "203.0.113.1");
  assert.equal(sent[0].params[0], "signup:ip:203.0.113.1");
});

// ------------------------------------------------------------- the window

test("a window boundary starts the count again", async () => {
  const { windowStart } = await rl$;
  const a = windowStart(60, new Date("2026-08-25T10:00:59.000Z"));
  const b = windowStart(60, new Date("2026-08-25T10:01:00.000Z"));
  assert.notEqual(a.getTime(), b.getTime());
  assert.equal(b.getTime() - a.getTime(), 60_000);
});

// ------------------------------------------- what a database failure means

test("signup fails OPEN when the database is down", async () => {
  const { takeToken } = await rl$;
  // Mirrors countIfUnder. A hiccup must not be experienced as "I was refused
  // for no reason"; a few junk signups during an outage is the cheaper error.
  withDb(() => ({ rows: [], rowCount: 0 }), new Error("connection terminated"));
  assert.deepEqual(await takeToken("signup:ip", "203.0.113.1"), { ok: true });
});

test("login fails CLOSED when the database is down", async () => {
  const { takeToken } = await rl$;
  // The asymmetry is deliberate and matches takeFreeFix. Being wrong open on
  // signup costs a few junk accounts; being wrong open here costs an account.
  withDb(() => ({ rows: [], rowCount: 0 }), new Error("connection terminated"));
  const v = await takeToken("login:email-ip", "a@b.com|203.0.113.1");
  assert.equal(v.ok, false);
});

// ------------------------------------------------------------- the three modes

test("mode off does not reach the database at all", async () => {
  const { takeToken, setModeForTest } = await rl$;
  setModeForTest("off");
  withDb(() => ({ rows: [], rowCount: 0 }));
  assert.deepEqual(await takeToken("signup:ip", "203.0.113.1"), { ok: true });
  assert.equal(sent.length, 0);
  setModeForTest("enforce");
});

test("mode count never refuses, and keeps counting PAST the ceiling", async () => {
  const { takeToken, setModeForTest } = await rl$;
  setModeForTest("count");
  withDb(() => ({ rows: [{ hits: 99 }], rowCount: 1 }));
  assert.deepEqual(await takeToken("signup:ip", "203.0.113.1"), { ok: true });
  // The observation week exists to choose real ceilings from real numbers. An
  // upsert that stopped incrementing at the guessed limit would only ever teach
  // us "somebody reached 5" and never how far past it they went -- which is the
  // one number the ceiling is supposed to be picked from. Same reason
  // countIfUnder counts unlimited plans.
  assert.doesNotMatch(sent[0].sql, /WHERE rate_limits\.hits </);
  setModeForTest("enforce");
});

// ------------------------------------------------------------- housekeeping

test("the sweep is bounded by window_start and nothing else", async () => {
  const { sweepOldWindows } = await rl$;
  withDb(() => ({ rows: [], rowCount: 4 }));
  assert.equal(await sweepOldWindows(), 4);
  assert.match(sent[0].sql, /DELETE FROM rate_limits WHERE window_start < now\(\)/);
  // A sweep that could match on bucket would eventually be given a bucket
  // pattern to match on, and a DELETE with a caller-shaped predicate over the
  // table that decides who is refused is not a thing worth having.
  assert.doesNotMatch(sent[0].sql, /bucket/);
});

test("a failed sweep is zero, not a thrown reconcile", async () => {
  const { sweepOldWindows } = await rl$;
  // The reconcile job does several unrelated things. Limiter housekeeping
  // failing must not take the domain checks down with it.
  withDb(() => ({ rows: [], rowCount: 0 }), new Error("connection terminated"));
  assert.equal(await sweepOldWindows(), 0);
});
