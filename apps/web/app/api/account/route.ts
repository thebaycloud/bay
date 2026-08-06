export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { currentUserId } from "@/lib/session";
import { getAccount, updateName } from "@/lib/users";
import { entitlement, countOwnerApps, countPublicApps } from "@/lib/entitlements";
import { usageFor, freeFixAvailable } from "@/lib/usage";

// Infinity does not survive JSON.stringify (it becomes null), and a limit the
// client cannot distinguish from "unknown" is a limit the client renders wrong.
// null is the wire form of unlimited, said once here.
const cap = (n: number): number | null => (Number.isFinite(n) ? n : null);

// Everything the app chrome needs: who you are, your plan, and every meter the
// dashboard shows. There is no trial clock any more — free is the resting state,
// so nothing counts down and `access` is 'active' for everyone with an account.
export async function GET() {
  const uid = await currentUserId();
  if (!uid) return Response.json({ error: "not signed in" }, { status: 401 });
  const account = await getAccount(uid);
  if (!account) return Response.json({ error: "not found" }, { status: 404 });
  const ent = await entitlement(uid);
  const [apps, publicApps, used, freeFix] = await Promise.all([
    countOwnerApps(uid),
    countPublicApps(uid),
    usageFor(uid),
    freeFixAvailable(uid),
  ]);
  return Response.json({
    ...account,
    plan: ent.plan,
    access: ent.access,         // "active" | "locked"
    status: ent.status,
    locked: ent.locked,
    usage: {
      apps,
      maxApps: cap(ent.limits.maxApps),
      publicApps,
      maxPublicApps: cap(ent.limits.maxPublicApps),
      maxGrants: cap(ent.limits.maxGrants),
      builds: used.builds,
      monthlyBuilds: cap(ent.limits.monthlyBuilds),
      agentRuns: used.agentRuns,
      monthlyAgentRuns: cap(ent.limits.monthlyAgentRuns),
      periodStart: used.periodStart,
      // Only meaningful on free, where auto-fix is otherwise off: it is the
      // difference between "upgrade to get this" and "you still have one".
      freeFixAvailable: ent.limits.lifetimeFreeFixes > 0 && freeFix,
    },
    features: {
      autoFix: ent.limits.autoFix,
      customDomains: ent.limits.customDomains,
      canRemoveBadge: ent.limits.canRemoveBadge,
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
