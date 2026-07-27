export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { currentUserId } from "@/lib/session";
import { getAccount, updateName } from "@/lib/users";
import { storedPlan } from "@/lib/entitlements";

// The settings page's account section: who you are + which plan you're on.
export async function GET() {
  const uid = await currentUserId();
  if (!uid) return Response.json({ error: "not signed in" }, { status: 401 });
  const account = await getAccount(uid);
  if (!account) return Response.json({ error: "not found" }, { status: 404 });
  const plan = await storedPlan(uid);
  return Response.json({ ...account, plan });
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
