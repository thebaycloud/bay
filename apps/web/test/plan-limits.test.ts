import { test, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * The pricing model, against a driver that is not a database.
 *
 * Everything here is about rules that are cheap to state and expensive to get
 * wrong: what a plan includes, whether a cancelled subscription takes somebody's
 * apps away, and whether a meter can be raced past its own ceiling. None of it
 * needs Postgres, and running it against Postgres would be worse than useless —
 * `getPool` points at 127.0.0.1:5433, so a test that "just tried it" would
 * quietly mutate production on any machine with cloud-sql-proxy running.
 *
 * `GATING_ENABLED` is set BEFORE the import, because lib/entitlements reads it
 * once at module load. With it unset every limit is Infinity and every assertion
 * below would pass while testing nothing.
 */
process.env.GATING_ENABLED = "1";

type Result = { rows: unknown[]; rowCount: number };
type Handler = (sql: string, params: unknown[]) => Result;

let handler: Handler = () => ({ rows: [], rowCount: 0 });
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

// Deferred, not top-level-await: tsx compiles these to CJS, where top-level
// await is a syntax error. Creating the promise here rather than importing
// statically is also what keeps it below `mock.module` — a static import is
// hoisted above it and would load the real `lib/db`.
const ent$ = import("@/lib/entitlements");
const usage$ = import("@/lib/usage");
const copy$ = import("@/lib/plan-copy");

// ---------------------------------------------------------------- the plans

test("free is bounded on every axis that costs money", async () => {
  const { LIMITS } = await ent$;
  const f = LIMITS.free;
  assert.equal(f.maxApps, 3);
  assert.equal(f.maxPublicApps, 1);
  assert.equal(f.autoFix, false);
  assert.equal(f.lifetimeFreeFixes, 1);
  // The two that bound spend rather than features. A free plan with either of
  // these unbounded is the hole this whole change exists to close.
  assert.ok(Number.isFinite(f.monthlyBuilds), "free must have a build ceiling");
  assert.equal(f.monthlyAgentRuns, 0, "free gets the lifetime fix, not a monthly allowance");
});

test("sharing by email is unlimited on every plan", async () => {
  const { LIMITS } = await ent$;
  // Recipients are how small software spreads. A cap here would tax our own
  // growth loop, and it is the one limit that must never quietly reappear.
  for (const plan of ["free", "pro", "team"] as const) {
    assert.equal(LIMITS[plan].maxGrants, Infinity, `${plan} must not cap recipients`);
  }
});

test("paid plans are a superset of free", async () => {
  const { LIMITS } = await ent$;
  for (const plan of ["pro", "team"] as const) {
    const p = LIMITS[plan];
    assert.ok(p.maxApps >= LIMITS.free.maxApps, `${plan} apps`);
    assert.ok(p.maxPublicApps >= LIMITS.free.maxPublicApps, `${plan} public apps`);
    assert.ok(p.monthlyBuilds >= LIMITS.free.monthlyBuilds, `${plan} builds`);
    assert.ok(p.maxConcurrentDeploys >= LIMITS.free.maxConcurrentDeploys, `${plan} concurrency`);
    assert.equal(p.autoFix, true);
    assert.equal(p.canRemoveBadge, true);
    assert.equal(p.customDomains, true);
  }
});

test("even unlimited plans keep a concurrency cap", async () => {
  const { LIMITS } = await ent$;
  // Physical, not commercial: each concurrent deploy holds a Cloud Run Job task
  // and a slot in a shared build pool, so an unlimited Pro would let one account
  // starve everybody else — experienced by them as deploys that hang.
  for (const plan of ["pro", "team"] as const) {
    assert.ok(Number.isFinite(LIMITS[plan].maxConcurrentDeploys), `${plan} must cap concurrency`);
  }
});

// ---------------------------------------------------------- what access means

test("a cancelled subscription downgrades to free — it does not lock", async () => {
  const { entitlement, LIMITS } = await ent$;
  withDb(() => ({ rows: [{ plan: "pro", status: "canceled" }], rowCount: 1 }));
  const ent = await entitlement("u1");
  assert.equal(ent.locked, false, "cancelling must never lock somebody out");
  assert.equal(ent.access, "active");
  assert.equal(ent.plan, "free");
  assert.equal(ent.limits.maxApps, LIMITS.free.maxApps);
});

test("past_due keeps its plan — Stripe is still retrying", async () => {
  const { entitlement } = await ent$;
  withDb(() => ({ rows: [{ plan: "pro", status: "past_due" }], rowCount: 1 }));
  const ent = await entitlement("u1");
  assert.equal(ent.plan, "pro");
  assert.equal(ent.limits.autoFix, true);
});

test("a free user is active, never locked", async () => {
  const { entitlement } = await ent$;
  withDb(() => ({ rows: [{ plan: "free", status: "active" }], rowCount: 1 }));
  const ent = await entitlement("u1");
  assert.equal(ent.locked, false);
  assert.equal(ent.limits.maxApps, 3);
});

test("no user row is the only thing that locks", async () => {
  const { entitlement } = await ent$;
  withDb(() => ({ rows: [], rowCount: 0 }));
  const ent = await entitlement("ghost");
  assert.equal(ent.locked, true);
});

test("a database error fails open, not closed", async () => {
  const { entitlement } = await ent$;
  withDb(() => ({ rows: [], rowCount: 0 }), new Error("connection terminated"));
  const ent = await entitlement("u1");
  assert.equal(ent.locked, false, "a blip must never lock a paying user out");
  assert.equal(ent.plan, "pro");
  // Ceilings too: the meter reads the same database, so it is failing open as
  // well. A finite limit here would be a refusal nothing could enforce and
  // nobody could explain.
  assert.equal(ent.limits.monthlyBuilds, Infinity);
  assert.equal(ent.limits.monthlyAgentRuns, Infinity);
});

// ------------------------------------------------------------------ the meter

test("the ceiling is applied inside the upsert, not before it", async () => {
  const { countIfUnder, periodStart } = await usage$;
  // The whole point: check-then-increment as two statements lets five
  // concurrent deploys all read "29 of 30" and all pass. The limit has to ride
  // on the DO UPDATE's WHERE so Postgres serialises it for us.
  withDb(() => ({ rows: [{ builds: 5 }], rowCount: 1 }));
  await countIfUnder("u1", "builds", 30);
  const q = sent[0];
  assert.match(q.sql, /ON CONFLICT .* DO UPDATE/i);
  assert.match(q.sql, /WHERE usage_counters\.builds < \$3/i);
  assert.deepEqual(q.params, ["u1", periodStart(), 30]);
});

test("no row updated means the ceiling was reached", async () => {
  const { countIfUnder } = await usage$;
  withDb(() => ({ rows: [], rowCount: 0 }));
  assert.equal(await countIfUnder("u1", "builds", 30), false);
});

test("a zero ceiling refuses without touching the database", async () => {
  const { countIfUnder } = await usage$;
  // The INSERT arm of the upsert has no WHERE to fail, so a limit of 0 would
  // otherwise let the first event of every month straight through.
  withDb(() => ({ rows: [{ agent_runs: 1 }], rowCount: 1 }));
  assert.equal(await countIfUnder("u1", "agentRuns", 0), false);
  assert.equal(sent.length, 0, "must not have issued a query");
});

test("unlimited plans are still counted", async () => {
  const { countIfUnder } = await usage$;
  // A plan that records nothing is a plan we cannot price later.
  withDb(() => ({ rows: [], rowCount: 0 }));
  assert.equal(await countIfUnder("u1", "builds", Infinity), true);
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].sql, /WHERE usage_counters/i, "no ceiling to apply");
});

test("a meter outage lets the deploy through", async () => {
  const { countIfUnder } = await usage$;
  withDb(() => ({ rows: [], rowCount: 0 }), new Error("timeout"));
  assert.equal(await countIfUnder("u1", "builds", 30), true);
});

test("periods are UTC calendar months", async () => {
  const { periodStart } = await usage$;
  assert.equal(periodStart(new Date("2026-08-06T12:00:00Z")), "2026-08-01");
  assert.equal(periodStart(new Date("2026-12-31T23:59:59Z")), "2026-12-01");
  // The boundary a local-timezone implementation gets wrong: still January in
  // UTC, already February somewhere east of it.
  assert.equal(periodStart(new Date("2026-01-31T23:00:00Z")), "2026-01-01");
});

// ------------------------------------------------------------- the free fix

test("the free fix is claimed conditionally, so two failures cannot both take it", async () => {
  const { claimFreeFix } = await usage$;
  withDb(() => ({ rows: [{ id: "u1" }], rowCount: 1 }));
  assert.equal(await claimFreeFix("u1"), true);
  assert.match(sent[0].sql, /WHERE id = \$1 AND free_fix_used_at IS NULL/i);
});

test("a spent free fix returns false", async () => {
  const { claimFreeFix } = await usage$;
  withDb(() => ({ rows: [], rowCount: 0 }));
  assert.equal(await claimFreeFix("u1"), false);
});

test("the free fix fails CLOSED, unlike every other limit", async () => {
  const { claimFreeFix } = await usage$;
  // Deliberately asymmetric. Every other failure here costs a build; this one
  // costs an unbounded LLM session, and the fallback — a paste-ready prompt —
  // is the same thing the user gets on their second failure anyway.
  withDb(() => ({ rows: [], rowCount: 0 }), new Error("connection terminated"));
  assert.equal(await claimFreeFix("u1"), false);
});

// -------------------------------------------------------------------- copy

test("limit messages name the number and the way out", async () => {
  const { LIMITS } = await ent$;
  const { appLimitMessage, publicLimitMessage, buildLimitMessage } = await copy$;
  const app = appLimitMessage(LIMITS.free);
  assert.match(app, /3/);
  assert.match(app, /\$20/);
  // Says what stays, not only what stops — the public cap is the one people
  // most often read as "I can't share this".
  assert.match(publicLimitMessage(LIMITS.free), /email/i);
  assert.match(buildLimitMessage(LIMITS.free), /reset/i);
});
