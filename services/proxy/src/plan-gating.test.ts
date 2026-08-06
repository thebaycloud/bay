import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The badge with plan enforcement switched off.
 *
 * Its own file because `config` reads `GATING_ENABLED` once, at module load, so
 * the two values of the flag cannot both be exercised in one process. Deleting
 * the variable and re-importing with a cache-busting query string looks like it
 * works and does not: it reloads `plan.ts` but not the `config.ts` underneath,
 * so the assertion passes against the old value.
 *
 * What this protects: the proxy must not start enforcing plans before the
 * control plane does. GATING_ENABLED is deliberately one switch for both, and
 * with it off the edge behaves exactly as it did before plans existed — a badge
 * on every app, including the ones whose owners the dashboard is still treating
 * as unlimited.
 */
process.env.AUTH_SECRET = "test-secret";
delete process.env.GATING_ENABLED;

const plan$ = import("./plan");

test("with gating off, every app keeps the badge", async () => {
  const { badgeRequired } = await plan$;
  assert.equal(badgeRequired("pro", "active"), true);
  assert.equal(badgeRequired("team", "active"), true);
  assert.equal(badgeRequired("free", "active"), true);
});
