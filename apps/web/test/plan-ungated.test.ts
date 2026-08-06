import { test, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * What the pricing model does while enforcement is switched off.
 *
 * Its own file because `lib/entitlements` reads `GATING_ENABLED` once at module
 * load, so the flag's two values cannot both be exercised in one process —
 * plan-limits.test.ts owns the "on" side.
 *
 * The contract this protects is the one the whole change was shipped behind:
 * with the flag off, NOTHING is enforced. That was easy to hold when every
 * limit was either a capability or Infinity, and it stopped being easy the
 * moment monthly ceilings arrived — Pro's own `monthlyBuilds` is 500 and
 * `monthlyAgentRuns` is 100, so handing out LIMITS.pro to everyone would have
 * started refusing real builds under a flag that means "nothing has changed".
 */
delete process.env.GATING_ENABLED;

mock.module("@/lib/db", {
  namedExports: {
    getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
  },
});

const ent$ = import("@/lib/entitlements");

test("with gating off nothing is enforced, ceilings included", async () => {
  const { entitlement } = await ent$;
  const e = await entitlement("anyone");
  assert.equal(e.locked, false);
  assert.equal(e.limits.maxApps, Infinity);
  assert.equal(e.limits.maxPublicApps, Infinity);
  assert.equal(e.limits.monthlyBuilds, Infinity, "a build cap under a flag that is off");
  assert.equal(e.limits.monthlyAgentRuns, Infinity, "an agent cap under a flag that is off");
  assert.equal(e.limits.autoFix, true);
});

test("an unknown user is not locked out while gating is off", async () => {
  const { entitlement } = await ent$;
  // No user row, no session, no plan — and still nothing refused, because the
  // flag says the model is not live yet.
  const e = await entitlement("");
  assert.equal(e.locked, false);
});

test("planLimits agrees with entitlement", async () => {
  const { planLimits } = await ent$;
  const l = await planLimits("anyone");
  assert.equal(l.monthlyBuilds, Infinity);
  assert.equal(l.monthlyAgentRuns, Infinity);
});
