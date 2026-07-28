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

// Subscription status mirrors Stripe once a user pays; before that they're
// 'trialing' (app-managed, no card) or grandfathered 'active'.
export type SubStatus = "trialing" | "active" | "past_due" | "canceled";
// What a user may do right now: trial → full Pro, active → their plan's limits,
// locked → nothing billable (show the paywall).
export type AccessState = "trial" | "active" | "locked";

export interface Entitlement {
  access: AccessState;
  plan: Plan;                 // the plan they'd be on once active (for display/billing)
  limits: Limits;             // effective limits for this access state
  status: SubStatus;
  trialEndsAt: string | null; // ISO; null once they've paid or were grandfathered
  locked: boolean;            // true → block deploys/shares, render the paywall
}

/**
 * The single source of truth for what a user may do right now — combines the
 * subscription status, the trial clock, and the plan. Trial gives full Pro; an
 * expired trial (or cancellation) locks the account behind the paywall. With
 * gating off, everyone is unlocked Pro. Fails OPEN on a DB error so a blip never
 * locks a paying user out.
 */
export async function entitlement(userId: string): Promise<Entitlement> {
  if (!GATING) return { access: "active", plan: "pro", limits: LIMITS.pro, status: "active", trialEndsAt: null, locked: false };
  const locked: Entitlement = { access: "locked", plan: "basic", limits: LIMITS.basic, status: "canceled", trialEndsAt: null, locked: true };
  if (!userId) return locked;
  let row: { plan?: string; status?: string; trial_ends_at?: Date | string | null } | undefined;
  try {
    const r = await getPool(DB).query("SELECT plan, status, trial_ends_at FROM users WHERE id = $1", [userId]);
    row = r.rows[0];
  } catch {
    return { access: "active", plan: "pro", limits: LIMITS.pro, status: "active", trialEndsAt: null, locked: false };
  }
  if (!row) return locked;
  const plan: Plan = row.plan === "pro" ? "pro" : "basic";
  const status = (row.status ?? "active") as SubStatus;
  const trialEndsAt = row.trial_ends_at ? new Date(row.trial_ends_at).toISOString() : null;
  const trialLive = status === "trialing" && trialEndsAt !== null && new Date(trialEndsAt).getTime() > Date.now();

  if (status === "active" || status === "past_due")
    return { access: "active", plan, limits: LIMITS[plan], status, trialEndsAt, locked: false };
  if (trialLive)
    return { access: "trial", plan: "pro", limits: LIMITS.pro, status, trialEndsAt, locked: false };
  return { access: "locked", plan, limits: LIMITS[plan], status, trialEndsAt, locked: true };
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

/** Set a user's plan + status by id. Stripe ids are optional (webhook fills them in). */
export async function setPlanByUser(
  userId: string,
  plan: Plan,
  status: SubStatus,
  stripeCustomerId?: string | null,
  stripeSubscriptionId?: string | null
): Promise<void> {
  await getPool(DB).query(
    `UPDATE users SET plan = $2, status = $3,
       stripe_customer_id = COALESCE($4, stripe_customer_id),
       stripe_subscription_id = $5
     WHERE id = $1`,
    [userId, plan, status, stripeCustomerId ?? null, stripeSubscriptionId ?? null]
  );
}

/** Set the plan + status for whichever user owns a Stripe customer — the webhook path. */
export async function setPlanByCustomer(
  stripeCustomerId: string,
  plan: Plan,
  status: SubStatus,
  stripeSubscriptionId?: string | null
): Promise<void> {
  await getPool(DB).query(
    `UPDATE users SET plan = $2, status = $3, stripe_subscription_id = $4
     WHERE stripe_customer_id = $1`,
    [stripeCustomerId, plan, status, stripeSubscriptionId ?? null]
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
