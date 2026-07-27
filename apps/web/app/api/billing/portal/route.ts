export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { currentUserId } from "@/lib/session";
import { stripe, APP_URL } from "@/lib/stripe";
import { getPool } from "@/lib/db";

// Send an existing subscriber to Stripe's hosted portal to change or cancel.
export async function POST() {
  const uid = await currentUserId();
  if (!uid) return Response.json({ error: "not signed in" }, { status: 401 });

  const s = stripe();
  if (!s) return Response.json({ error: "billing not configured yet" }, { status: 503 });

  const r = await getPool("supersonic_platform").query(
    "SELECT stripe_customer_id FROM users WHERE id = $1",
    [uid]
  );
  const customerId = r.rows[0]?.stripe_customer_id;
  if (!customerId) return Response.json({ error: "no subscription yet" }, { status: 400 });

  const portal = await s.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${APP_URL}/`,
  });
  return Response.json({ url: portal.url });
}
