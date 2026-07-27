import Stripe from "stripe";
import type { Plan } from "./entitlements";

// Everything Stripe is read from env and stays inert until the keys exist, so
// this ships before billing is live. `stripe()` returns null when unconfigured;
// every route checks that and 503s cleanly rather than throwing.
const KEY = process.env.STRIPE_SECRET_KEY || "";
const PRICE_BASIC = process.env.STRIPE_PRICE_BASIC || "";
const PRICE_PRO = process.env.STRIPE_PRICE_PRO || "";
export const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
export const APP_URL = process.env.APP_URL || "https://app.supersonic.cv";

let client: Stripe | null = null;
export function stripe(): Stripe | null {
  if (!KEY) return null;
  if (!client) client = new Stripe(KEY);
  return client;
}

/** True only when we can actually run checkout — key + both prices present. */
export function billingConfigured(): boolean {
  return Boolean(KEY && PRICE_BASIC && PRICE_PRO);
}

export function priceForPlan(plan: Plan): string {
  return plan === "pro" ? PRICE_PRO : PRICE_BASIC;
}

/** Map a Stripe price back to our plan; null for an unknown price. */
export function planForPrice(priceId: string): Plan | null {
  if (priceId && priceId === PRICE_PRO) return "pro";
  if (priceId && priceId === PRICE_BASIC) return "basic";
  return null;
}
