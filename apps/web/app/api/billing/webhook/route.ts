export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { stripe, WEBHOOK_SECRET, planForPrice } from "@/lib/stripe";
import { setPlanByUser, setPlanByCustomer, setStatusByCustomer, type Plan, type SubStatus } from "@/lib/entitlements";
import type Stripe from "stripe";

// Collapse Stripe's subscription statuses into ours. active/trialing = usable;
// past_due/unpaid = grace (Stripe is retrying); everything else = locked.
function mapStatus(s: string): SubStatus {
  if (s === "active" || s === "trialing") return "active";
  if (s === "past_due" || s === "unpaid") return "past_due";
  return "canceled";
}

// Stripe → our plan column. The signature is verified against the raw body, so
// this must read req.text() (not req.json()). Unconfigured = 503; a bad
// signature = 400; anything we don't handle is acknowledged with 200 so Stripe
// stops retrying it.
export async function POST(req: Request) {
  const s = stripe();
  if (!s || !WEBHOOK_SECRET) return new Response("billing not configured", { status: 503 });

  const sig = req.headers.get("stripe-signature") || "";
  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = s.webhooks.constructEvent(raw, sig, WEBHOOK_SECRET);
  } catch (e) {
    return new Response(`bad signature: ${e instanceof Error ? e.message : "error"}`, { status: 400 });
  }

  const idOf = (v: unknown): string | null =>
    typeof v === "string" ? v : (v && typeof v === "object" && "id" in v ? String((v as { id: unknown }).id) : null);

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const uid = session.client_reference_id || (session.metadata?.userId ?? null);
        const subId = idOf(session.subscription);
        const customerId = idOf(session.customer);
        if (uid && subId) {
          const sub = await s.subscriptions.retrieve(subId);
          const priceId = sub.items.data[0]?.price?.id ?? "";
          const plan: Plan = planForPrice(priceId) ?? "pro";
          await setPlanByUser(uid, plan, mapStatus(sub.status), customerId, subId);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = idOf(sub.customer);
        const priceId = sub.items.data[0]?.price?.id ?? "";
        const plan = planForPrice(priceId);
        if (customerId) {
          // An unmappable price updates the status and leaves the plan alone.
          // The alternative — defaulting to free — silently downgrades a paying
          // customer whenever a price id is rotated in the Stripe dashboard
          // without the env var following it.
          if (plan) await setPlanByCustomer(customerId, plan, mapStatus(sub.status), sub.id);
          else await setStatusByCustomer(customerId, mapStatus(sub.status), sub.id);
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = idOf(sub.customer);
        // Subscription gone → back to free, NOT locked out. Their apps keep
        // running and they keep the free tier; what they lose is the fourth
        // app, custom domains, auto-fix and badge removal. Taking away access
        // to work somebody already deployed, because a card expired, is not a
        // thing we do — and it saves about a dollar a month.
        if (customerId) await setPlanByCustomer(customerId, "free", "canceled", null);
        break;
      }
      default:
        break;
    }
  } catch (e) {
    // Signal Stripe to retry — a transient DB error shouldn't silently lose an upgrade.
    return new Response(`handler error: ${e instanceof Error ? e.message : "error"}`, { status: 500 });
  }

  return new Response("ok", { status: 200 });
}
