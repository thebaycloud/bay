import { getPool } from "./db";

const DB = "supersonic_platform";

// Enforcement is off until billing is live. With it off, everyone is treated as
// pro (unlimited) regardless of the `plan` column, so shipping the gates changes
// nothing for existing users — no one gets locked out before they can pay. Flip
// GATING_ENABLED=1 once Stripe is wired and prices exist.
const GATING = process.env.GATING_ENABLED === "1";

export type Plan = "basic" | "pro";

export interface Limits {
  /** Max apps the owner may have deployed at once (Infinity = unlimited). */
  maxApps: number;
  /** Max people an app may be shared with by email (Infinity = unlimited). */
  maxGrants: number;
  /** Whether the repair agent auto-fixes failed deploys (else: paste-ready prompt). */
  autoFix: boolean;
  /** Whether the "Runs on Supersonic" badge can be removed. */
  canRemoveBadge: boolean;
}

export const LIMITS: Record<Plan, Limits> = {
  basic: { maxApps: 1, maxGrants: 3, autoFix: false, canRemoveBadge: false },
  pro: { maxApps: Infinity, maxGrants: Infinity, autoFix: true, canRemoveBadge: true },
};

/** The plan we enforce against. When gating is disabled, that is always pro. */
export async function getPlan(userId: string): Promise<Plan> {
  if (!GATING) return "pro";
  if (!userId) return "basic";
  try {
    const r = await getPool(DB).query("SELECT plan FROM users WHERE id = $1", [userId]);
    return r.rows[0]?.plan === "pro" ? "pro" : "basic";
  } catch {
    // A DB hiccup must not hand a paying user a locked account nor a free one an
    // upgrade — but between those, failing open (pro) avoids blocking real work.
    return "pro";
  }
}

export async function planLimits(userId: string): Promise<Limits> {
  return LIMITS[await getPlan(userId)];
}

/** The plan actually stored for a user, ignoring the gating flag — for display/billing. */
export async function storedPlan(userId: string): Promise<Plan> {
  if (!userId) return "basic";
  try {
    const r = await getPool(DB).query("SELECT plan FROM users WHERE id = $1", [userId]);
    return r.rows[0]?.plan === "pro" ? "pro" : "basic";
  } catch {
    return "basic";
  }
}

export function gatingEnabled(): boolean {
  return GATING;
}

/** Set a user's plan by id. Stripe ids are optional (webhook fills them in). */
export async function setPlanByUser(
  userId: string,
  plan: Plan,
  stripeCustomerId?: string | null,
  stripeSubscriptionId?: string | null
): Promise<void> {
  await getPool(DB).query(
    `UPDATE users SET plan = $2,
       stripe_customer_id = COALESCE($3, stripe_customer_id),
       stripe_subscription_id = $4
     WHERE id = $1`,
    [userId, plan, stripeCustomerId ?? null, stripeSubscriptionId ?? null]
  );
}

/** Set the plan for whichever user owns a Stripe customer — the webhook path. */
export async function setPlanByCustomer(
  stripeCustomerId: string,
  plan: Plan,
  stripeSubscriptionId?: string | null
): Promise<void> {
  await getPool(DB).query(
    `UPDATE users SET plan = $2, stripe_subscription_id = $3
     WHERE stripe_customer_id = $1`,
    [stripeCustomerId, plan, stripeSubscriptionId ?? null]
  );
}

/** Count apps owned by a user, optionally excluding one slug (a redeploy of it). */
export async function countOwnerApps(userId: string, excludeSlug?: string): Promise<number> {
  const r = await getPool(DB).query(
    `SELECT count(*)::int AS n FROM apps
     WHERE owner_id = $1 AND status <> 'failed'
       AND ($2::text IS NULL OR slug <> $2)`,
    [userId, excludeSlug ?? null]
  );
  return r.rows[0]?.n ?? 0;
}
