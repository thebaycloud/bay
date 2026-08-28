export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { currentUserId } from "@/lib/session";
import { stripe, billingConfigured, priceForPlan, APP_URL } from "@/lib/stripe";
import { CONTACT_EMAIL } from "@/lib/brand";
import { getPool } from "@/lib/db";
import type { Plan } from "@/lib/entitlements";

// Start a subscription. Reuses the user's Stripe customer if we've made one, so
// we never create duplicates across upgrades.
export async function POST(req: Request) {
  const uid = await currentUserId();
  if (!uid) return Response.json({ error: "not signed in" }, { status: 401 });

  const s = stripe();
  if (!s || !billingConfigured()) {
    return Response.json({ error: "billing not configured yet" }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  // Only paid plans reach checkout. "free" is not a thing you buy — it is where
  // you already are — so an unrecognised plan means Pro rather than an error.
  const plan: Plan = body.plan === "team" ? "team" : "pro";
  const price = priceForPlan(plan);
  if (!price) {
    // Team with no configured price: hand-priced, on purpose, while we learn
    // what it should cost. Answered as an invitation rather than a failure.
    return Response.json(
      { error: `Team plans are set up with us directly — email ${CONTACT_EMAIL} and we'll get you started.`, contact: true },
      { status: 503 }
    );
  }

  const pool = getPool("supersonic_platform");
  const r = await pool.query("SELECT email, stripe_customer_id FROM users WHERE id = $1", [uid]);
  const user = r.rows[0];
  if (!user) return Response.json({ error: "user not found" }, { status: 404 });

  let customerId: string | null = user.stripe_customer_id ?? null;
  if (!customerId) {
    const c = await s.customers.create({ email: user.email, metadata: { userId: uid } });
    customerId = c.id;
    await pool.query("UPDATE users SET stripe_customer_id = $2 WHERE id = $1", [uid, customerId]);
  }

  const session = await s.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price, quantity: 1 }],
    success_url: `${APP_URL}/?billing=success`,
    cancel_url: `${APP_URL}/?billing=cancel`,
    client_reference_id: uid,
    metadata: { userId: uid, plan },
    allow_promotion_codes: true,
  });

  return Response.json({ url: session.url });
}
