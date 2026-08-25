export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { notAuthenticatedBody } from "@/lib/api-error";
import { currentUserId } from "@/lib/session";
import { listTokens, revokeToken } from "@/lib/cli-tokens";

// CLI tokens the user's coding agent authenticates with. List + revoke only —
// creating a token stays a deliberate `supersonic login` browser flow.
export async function GET() {
  const uid = await currentUserId();
  if (!uid) return Response.json(notAuthenticatedBody(), { status: 401 });
  return Response.json({ tokens: await listTokens(uid) });
}

export async function POST(req: Request) {
  const uid = await currentUserId();
  if (!uid) return Response.json(notAuthenticatedBody(), { status: 401 });
  const body = await req.json().catch(() => ({}));
  const id = String(body.revoke ?? "");
  if (!id) return Response.json({ error: "missing token id" }, { status: 400 });
  const ok = await revokeToken(uid, id);
  if (!ok) return Response.json({ error: "token not found" }, { status: 404 });
  return Response.json({ ok: true });
}
