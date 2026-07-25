export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { currentUserId } from "@/lib/session";
import { createToken, listTokens, revokeToken } from "@/lib/cli-tokens";

// Mint a CLI token for the signed-in user (browser session cookie).
export async function POST(req: Request) {
  const uid = await currentUserId();
  if (!uid) return Response.json({ error: "not signed in" }, { status: 401 });
  const { name } = await req.json().catch(() => ({}));
  const { token, id } = await createToken(uid, String(name || "cli"));
  return Response.json({ token, id });
}

export async function GET() {
  const uid = await currentUserId();
  if (!uid) return Response.json({ error: "not signed in" }, { status: 401 });
  return Response.json({ tokens: await listTokens(uid) });
}

export async function DELETE(req: Request) {
  const uid = await currentUserId();
  if (!uid) return Response.json({ error: "not signed in" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  return Response.json({ ok: await revokeToken(uid, id) });
}
