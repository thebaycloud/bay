import { getPool } from "./db";

const DB = "supersonic_platform";

// Enforcement is off until billing is live. With it off, everyone is treated as
// pro (unlimited) regardless of the `plan` column, so shipping the gates changes
// nothing for existing users — no one gets locked out before they can pay. Flip
// GATING_ENABLED=1 once Stripe is wired and prices exist.
const GATING = process.env.GATING_ENABLED === "1";

export type Plan = "free" | "pro" | "team";

export interface Limits {
  /** Max apps the owner may have deployed at once (Infinity = unlimited). */
  maxApps: number;
  /**
   * Max apps that may be `visibility: 'public'` — reachable with no sign-in.
   *
   * Capped rather than withheld, and the distinction is the whole point. Public
   * is the abuse surface (free CDN, phishing host, egress) so it cannot be
   * unlimited on a plan with no card behind it. But it is also the only
   * visibility a stranger can open, which makes it how the badge — and so the
   * product — is ever seen by anyone who is not already a user. Gating it
   * entirely on free would have switched off acquisition to prevent abuse.
   */
  maxPublicApps: number;
  /**
   * Max people an app may be shared with by email (Infinity = unlimited).
   *
   * Unlimited on every plan, deliberately. Under the small-software framing the
   * recipients ARE the product working, and a cap here taxes the exact loop that
   * grows us. Retained as a field because the mechanism is worth keeping even
   * when the number is not.
   */
  maxGrants: number;
  /** Whether the repair agent auto-fixes failed deploys (else: paste-ready prompt). */
  autoFix: boolean;
  /**
   * Repair agent runs granted once per account, ever — spent on the first deploy
   * that actually FAILS, not the first deploy.
   *
   * The distinction matters and it is easy to get backwards: a grant spent on
   * the first deploy is usually spent on one that was going to succeed anyway,
   * which costs us a session and shows the user nothing. Spent on the first
   * failure, it is the one moment where the product does something no other
   * deploy tool does, for a bounded price.
   */
  lifetimeFreeFixes: number;
  /** Whether the "Runs on Supersonic" badge can be removed. */
  canRemoveBadge: boolean;
  /** Whether the owner may attach a domain they own. */
  customDomains: boolean;
  /**
   * Builds per calendar month, and repair-agent runs per calendar month.
   *
   * These are the only two limits here that bound a COST rather than a feature.
   * Everything else on this interface is about what a plan includes; a build
   * holds a Cloud Run Job task at 4Gi/2cpu for its duration and an agent run is
   * an LLM session, and before these existed nothing counted either. Per-RUN
   * agent cost was already bounded (MAX_STEPS, MAX_REDEPLOYS, REPAIR_MAX_CALLS);
   * per-MONTH volume was not bounded at all, which is the hole a free tier would
   * have opened.
   */
  monthlyBuilds: number;
  monthlyAgentRuns: number;
  /**
   * How many of this owner's deploys may be building at once.
   *
   * Unlike the two above, this one is about capacity in the moment rather than
   * spend over a month. Build cost per deploy rose 3-6x when every app started
   * building an image, and up to 24x on one the repair agent retries — and
   * nothing throttled, so the first busy hour would have been experienced as
   * every deploy hanging.
   */
  maxConcurrentDeploys: number;
}

export const LIMITS: Record<Plan, Limits> = {
  free: {
    maxApps: 3,
    maxPublicApps: 1,
    maxGrants: Infinity,
    autoFix: false,
    lifetimeFreeFixes: 1,
    canRemoveBadge: false,
    customDomains: false,
    monthlyBuilds: 30,
    monthlyAgentRuns: 0,
    maxConcurrentDeploys: 1,
  },
  // "Unlimited" apps with a fair-use ceiling rather than a number on the pricing
  // page: at ~$1.50/app/month resident, 200 apps is $300 of COGS against a $20
  // plan. Nobody has ever hit that and the shape of the promise is worth more
  // than the protection, so the ceiling lives in conversation, not in code.
  pro: {
    maxApps: Infinity,
    maxPublicApps: Infinity,
    maxGrants: Infinity,
    autoFix: true,
    lifetimeFreeFixes: 0,
    canRemoveBadge: true,
    customDomains: true,
    monthlyBuilds: 500,
    monthlyAgentRuns: 100,
    maxConcurrentDeploys: 5,
  },
  team: {
    maxApps: Infinity,
    maxPublicApps: Infinity,
    maxGrants: Infinity,
    autoFix: true,
    lifetimeFreeFixes: 0,
    canRemoveBadge: true,
    customDomains: true,
    monthlyBuilds: 500,
    monthlyAgentRuns: 100,
    maxConcurrentDeploys: 8,
  },
};

function asPlan(v: unknown): Plan {
  return v === "pro" || v === "team" ? v : "free";
}

/**
 * What everyone gets while enforcement is off: Pro, with the monthly ceilings
 * removed.
 *
 * Pro's own limits would NOT have been neutral here. `monthlyBuilds` and
 * `monthlyAgentRuns` are finite even on Pro, so handing out LIMITS.pro with
 * gating off would have started refusing builds and repair runs at 500 and 100
 * a month — a live behaviour change shipped by a flag that is supposed to mean
 * "nothing has changed yet". Every other limit on Pro is already Infinity or a
 * capability, so this is the only correction needed.
 *
 * The meters still COUNT under these limits — `countIfUnder` records an
 * unlimited ceiling too — which is the point: the numbers that will decide
 * where the real ceilings go get collected before anything is enforced.
 */
const UNGATED: Limits = { ...LIMITS.pro, monthlyBuilds: Infinity, monthlyAgentRuns: Infinity };

/** The plan we enforce against. When gating is disabled, that is always pro. */
export async function getPlan(userId: string): Promise<Plan> {
  if (!GATING) return "pro";
  if (!userId) return "free";
  try {
    const r = await getPool(DB).query("SELECT plan FROM users WHERE id = $1", [userId]);
    return asPlan(r.rows[0]?.plan);
  } catch {
    // A DB hiccup must not hand a paying user a locked account nor a free one an
    // upgrade — but between those, failing open (pro) avoids blocking real work.
    return "pro";
  }
}

export async function planLimits(userId: string): Promise<Limits> {
  if (!GATING) return UNGATED;
  return LIMITS[await getPlan(userId)];
}

// Subscription status mirrors Stripe. Users who have never paid are 'active' on
// the free plan — there is no trial, so there is no state that expires.
// 'trialing' is retained only because rows written before this model still carry
// it; `entitlement` reads it as active.
export type SubStatus = "trialing" | "active" | "past_due" | "canceled";
// What a user may do right now. 'locked' survives as a state but is now nearly
// unreachable — see `entitlement`.
export type AccessState = "active" | "locked";

export interface Entitlement {
  access: AccessState;
  plan: Plan;                 // the plan being enforced right now
  limits: Limits;             // effective limits for that plan
  status: SubStatus;
  locked: boolean;            // true → block deploys/shares, render the paywall
}

/**
 * The single source of truth for what a user may do right now.
 *
 * The rule that replaced the trial clock: **a lapsed subscription downgrades to
 * free, it does not lock.** Someone who cancels keeps their apps running and
 * keeps the free tier; what they lose is the ability to add a fourth app, a
 * custom domain, auto-fix and badge removal. Deleting access to work somebody
 * already deployed — because a card expired — is the kind of thing that gets
 * written about, and it buys nothing: the apps are already running and the
 * marginal cost of leaving them up is about a dollar.
 *
 * So `locked` is now reachable only when gating is on and there is no user row
 * at all, which is a broken state rather than a billing one.
 *
 * Fails OPEN on a DB error so a blip never blocks a paying user.
 */
export async function entitlement(userId: string): Promise<Entitlement> {
  const unlocked = (plan: Plan, status: SubStatus): Entitlement =>
    ({ access: "active", plan, limits: LIMITS[plan], status, locked: false });

  if (!GATING) return { access: "active", plan: "pro", limits: UNGATED, status: "active", locked: false };
  if (!userId) return { access: "locked", plan: "free", limits: LIMITS.free, status: "canceled", locked: true };

  let row: { plan?: string; status?: string } | undefined;
  try {
    const r = await getPool(DB).query("SELECT plan, status FROM users WHERE id = $1", [userId]);
    row = r.rows[0];
  } catch {
    // Maximally permissive, ceilings included. The meter reads the same
    // database, so it is failing open too — a finite limit here would be a
    // promise nothing can keep and a refusal nobody can explain.
    return { access: "active", plan: "pro", limits: UNGATED, status: "active", locked: false };
  }
  if (!row) return { access: "locked", plan: "free", limits: LIMITS.free, status: "canceled", locked: true };

  const stored = asPlan(row.plan);
  const status = (row.status ?? "active") as SubStatus;
  // 'past_due' is grace, not loss: Stripe is still retrying the card, and it
  // will either succeed or cancel the subscription itself. Downgrading during
  // the retry window would punish a user for a bank's fraud hold.
  const paidUp = status !== "canceled";
  return unlocked(paidUp ? stored : "free", status);
}

/** The plan actually stored for a user, ignoring the gating flag — for display/billing. */
export async function storedPlan(userId: string): Promise<Plan> {
  if (!userId) return "free";
  try {
    const r = await getPool(DB).query("SELECT plan FROM users WHERE id = $1", [userId]);
    return asPlan(r.rows[0]?.plan);
  } catch {
    return "free";
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

/**
 * Update only the subscription status for a Stripe customer, leaving the plan.
 *
 * For the webhook's awkward case: a subscription event whose price we cannot
 * map to a plan. Guessing there is the one move with a genuinely bad outcome —
 * defaulting to free would downgrade somebody in the middle of paying us,
 * because a price id was rotated in the Stripe dashboard and nobody updated an
 * env var. Statuses are unambiguous, so we take the half we are sure about.
 */
export async function setStatusByCustomer(stripeCustomerId: string, status: SubStatus, stripeSubscriptionId?: string | null): Promise<void> {
  await getPool(DB).query(
    `UPDATE users SET status = $2, stripe_subscription_id = COALESCE($3, stripe_subscription_id)
     WHERE stripe_customer_id = $1`,
    [stripeCustomerId, status, stripeSubscriptionId ?? null]
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

/**
 * Count this owner's public apps, excluding one slug — the app being changed.
 *
 * The exclusion is what makes re-setting an already-public app to public
 * idempotent rather than a refusal at the cap.
 */
export async function countPublicApps(userId: string, excludeSlug?: string): Promise<number> {
  const r = await getPool(DB).query(
    `SELECT count(*)::int AS n FROM apps
     WHERE owner_id = $1 AND status <> 'failed' AND visibility = 'public'
       AND ($2::text IS NULL OR slug <> $2)`,
    [userId, excludeSlug ?? null]
  );
  return r.rows[0]?.n ?? 0;
}
