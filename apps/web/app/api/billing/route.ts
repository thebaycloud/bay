export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { currentUserId } from "@/lib/session";
import { storedPlan, gatingEnabled } from "@/lib/entitlements";
import { billingConfigured } from "@/lib/stripe";

// What the dashboard needs to render the plan pill: the user's stored plan,
// whether enforcement is live, and whether checkout can actually run yet.
export async function GET() {
  const uid = await currentUserId();
  if (!uid) return Response.json({ error: "not signed in" }, { status: 401 });
  const plan = await storedPlan(uid);
  return Response.json({
    plan,
    gating: gatingEnabled(),
    billingConfigured: billingConfigured(),
  });
}
