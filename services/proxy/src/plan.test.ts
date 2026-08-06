import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The badge rule, and the fact that it is a copy.
 *
 * `badgeRequired` restates `Limits.canRemoveBadge` from
 * apps/web/lib/entitlements.ts, because deciding it here would otherwise mean a
 * control-plane round trip in front of every HTML page a hosted app serves. A
 * copied rule drifts, and the drift is silent: nobody files a bug saying "the
 * badge I pay to remove is back", they just stop paying.
 *
 * So the last test reads the plan names straight out of that file. It is a
 * crude coupling and it is the point — the day somebody adds a fourth plan
 * there, this fails here rather than in production.
 */

const REQUIRED_ENV = { AUTH_SECRET: "test-secret" };
Object.assign(process.env, REQUIRED_ENV);
process.env.GATING_ENABLED = "1";

const plan$ = import("./plan");

test("free carries the badge", async () => {
  const { badgeRequired } = await plan$;
  assert.equal(badgeRequired("free", "active"), true);
});

test("paid plans may remove it", async () => {
  const { badgeRequired } = await plan$;
  assert.equal(badgeRequired("pro", "active"), false);
  assert.equal(badgeRequired("team", "active"), false);
});

test("a cancelled subscription gets the badge back", async () => {
  const { badgeRequired } = await plan$;
  // Same rule as `entitlement()`: cancelling drops you to free, and free wears
  // the badge. The apps keep running; the branding comes back.
  assert.equal(badgeRequired("pro", "canceled"), true);
});

test("past_due keeps the badge off — Stripe is still retrying", async () => {
  const { badgeRequired } = await plan$;
  // A bank's fraud hold is not a downgrade, and putting our branding back on
  // somebody's app for three days while a card retries is not a good way to
  // find out about it.
  assert.equal(badgeRequired("pro", "past_due"), false);
});

test("an unknown or missing plan wears the badge", async () => {
  const { badgeRequired } = await plan$;
  // `users.status` is nullable and a row can predate any of this. Defaulting to
  // "show it" means the failure mode is a badge somebody paid to remove — which
  // they will tell us about — rather than free apps quietly shipping unbranded.
  assert.equal(badgeRequired(null, null), true);
  assert.equal(badgeRequired(undefined, undefined), true);
  assert.equal(badgeRequired("enterprise-2027", "active"), true);
});

test("the rule agrees with the plans the control plane defines", async () => {
  const { badgeRequired } = await plan$;
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(
    join(import.meta.dirname, "../../../apps/web/lib/entitlements.ts"),
    "utf8"
  );
  // `export type Plan = "free" | "pro" | "team";`
  const decl = /export type Plan =([^;]+);/.exec(src);
  assert.ok(decl, "could not find the Plan type — has entitlements.ts moved?");
  const plans = [...decl[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(plans.length >= 2, "expected at least a free and a paid plan");

  for (const p of plans) {
    // `canRemoveBadge: true` in LIMITS must mean `badgeRequired === false`.
    const block = new RegExp(`\\b${p}: \\{[\\s\\S]*?\\n  \\}`, "m").exec(src);
    assert.ok(block, `no LIMITS entry for plan "${p}"`);
    const canRemove = /canRemoveBadge: true/.test(block[0]);
    assert.equal(
      badgeRequired(p, "active"),
      !canRemove,
      `badgeRequired disagrees with LIMITS.${p}.canRemoveBadge`
    );
  }
});

// The gating-off case is in plan-gating.test.ts: `config` reads the env once at
// module load, so the only honest way to test the other value of the flag is a
// different process. A query-string re-import busts this module's cache but not
// the config module underneath it, which makes it look like it works.
