import Stripe from "stripe";
import type { Plan } from "./entitlements";
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
