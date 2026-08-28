import Stripe from "stripe";
import type { Plan, SubStatus } from "./entitlements";
import { controlPlaneUrl } from "./brand";

// Everything Stripe is read from env and stays inert until the keys exist, so
// this ships before billing is live. `stripe()` returns null when unconfigured;
// every route checks that and 503s cleanly rather than throwing.
const KEY = process.env.STRIPE_SECRET_KEY || "";
const PRICE_PRO = process.env.STRIPE_PRICE_PRO || "";
// Team is hand-priced while we learn what it is worth, so this is expected to
// be empty for a while. An empty price is not a misconfiguration: `priceForPlan`
// returns "" and checkout answers with "talk to us" instead of a Stripe error.
const PRICE_TEAM = process.env.STRIPE_PRICE_TEAM || "";
export const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
export const APP_URL = controlPlaneUrl();

let client: Stripe | null = null;
export function stripe(): Stripe | null {
  if (!KEY) return null;
  if (!client) client = new Stripe(KEY);
  return client;
}

/**
 * True when self-serve checkout can actually run — key + the Pro price.
 *
 * Pro alone, deliberately. It is the only plan anybody can buy without talking
 * to us: free needs no checkout and team is an invoice. Requiring every price to
 * exist would keep billing switched off until a Team price we have not decided
 * on yet is created.
 */
export function billingConfigured(): boolean {
  return Boolean(KEY && PRICE_PRO);
}

/** The Stripe price for a plan; "" when there is nothing to buy (free, or unpriced team). */
export function priceForPlan(plan: Plan): string {
  if (plan === "pro") return PRICE_PRO;
  if (plan === "team") return PRICE_TEAM;
  return "";
}

/** Map a Stripe price back to our plan; null for an unknown price. */
export function planForPrice(priceId: string): Plan | null {
  if (!priceId) return null;
  if (priceId === PRICE_PRO) return "pro";
  if (PRICE_TEAM && priceId === PRICE_TEAM) return "team";
  return null;
}

/**
 * Stripe's subscription status, collapsed into ours.
 *
 * Here rather than in the webhook route because a Next route file may only
 * export HTTP verbs, so a helper defined there is unreachable by a test — the
 * same reason `logs-query.ts` exists. This one had a bug worth a test.
 */
export function mapStatus(s: string): SubStatus {
  if (s === "active" || s === "trialing") return "active";
  // 'past_due' ONLY. `entitlement()` keeps every paid perk for any status that
  // is not 'canceled', and the reason it gives is that "Stripe is still
  // retrying the card" — which is exactly what past_due means and exactly what
  // 'unpaid' does not. 'unpaid' is where Stripe puts a subscription once dunning
  // is OVER and it has stopped trying, so folding the two together handed
  // somebody unlimited apps, 500 builds and 100 agent runs a month, forever,
  // after we had established we were never getting paid.
  if (s === "past_due") return "past_due";
  return "canceled";
}
