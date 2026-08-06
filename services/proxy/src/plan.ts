import { config } from "./config";

/**
 * Whether an app must carry the "Runs on Supersonic" badge.
 *
 * The second copy of a rule that lives in `apps/web/lib/entitlements.ts` as
 * `Limits.canRemoveBadge`, and it is a copy on purpose: the badge is decided in
 * the response path, where reaching for an entitlement over HTTP would put a
 * control-plane round trip in front of every HTML page an app serves. What
 * travels instead is the plan column, already joined into the app row.
 *
 * Kept honest by `plan.test.ts`, which asserts this agrees with LIMITS.
 *
 * When gating is off the badge is shown to everyone, which is exactly what the
 * proxy did before plans existed. That makes GATING_ENABLED the single switch
 * for the whole pricing model rather than something the edge decides on its own
 * schedule — and it means flipping the flag is the only way anybody's badge
 * disappears.
 */
export function badgeRequired(plan: string | null | undefined, status: string | null | undefined): boolean {
  if (!config.gatingEnabled) return true;
  // A canceled subscription is back on free, so the badge comes back with it.
  // Same rule as `entitlement()`: 'past_due' is grace and keeps its perks,
  // because Stripe is still retrying and a bank's fraud hold is not a downgrade.
  if (status === "canceled") return true;
  return plan !== "pro" && plan !== "team";
}
