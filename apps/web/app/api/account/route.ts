export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { currentUserId } from "@/lib/session";
import { getAccount, updateName } from "@/lib/users";
import { entitlement, countOwnerApps } from "@/lib/entitlements";

// Everything the app chrome needs: who you are, your plan, your access state
// (trial / active / locked), the trial clock, and current usage for the meters.
export async function GET() {
  const uid = await currentUserId();
  if (!uid) return Response.json({ error: "not signed in" }, { status: 401 });
  const account = await getAccount(uid);
  if (!account) return Response.json({ error: "not found" }, { status: 404 });
  const ent = await entitlement(uid);
  const apps = await countOwnerApps(uid);
  return Response.json({
    ...account,
    plan: ent.plan,
    access: ent.access,         // "trial" | "active" | "locked"
    status: ent.status,
    trialEndsAt: ent.trialEndsAt,
    locked: ent.locked,
    usage: {
      apps,
      maxApps: Number.isFinite(ent.limits.maxApps) ? ent.limits.maxApps : null,
      maxGrants: Number.isFinite(ent.limits.maxGrants) ? ent.limits.maxGrants : null,
    },
  });
}

export async function PATCH(req: Request) {
  const uid = await currentUserId();
  if (!uid) return Response.json({ error: "not signed in" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (typeof body.name !== "string") return Response.json({ error: "invalid name" }, { status: 400 });
  const name = body.name.slice(0, 120);
  await updateName(uid, name);
  return Response.json({ ok: true, name: name.trim() || null });
}
