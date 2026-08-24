export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { currentUserId } from "@/lib/session";
import { createToken, listTokens, revokeToken } from "@/lib/cli-tokens";
import { browserLabel } from "@/lib/client-label";

// Mint a CLI token for the signed-in user (browser session cookie).
export async function POST(req: Request) {
  const uid = await currentUserId();
  if (!uid) return Response.json({ error: "not signed in" }, { status: 401 });
  const { name } = await req.json().catch(() => ({}));
  // The CLI names the machine — `os.hostname()`, so "MacBook-Pro-3.local". A
  // browser names nothing, and the fallback was the literal "cli", which made
  // every hand-made token identical in a list whose job is telling them apart.
  // Derived HERE rather than in the page: the header is already on the request,
  // and one implementation cannot drift from another.
  const label = String(name || "").trim() || browserLabel(req.headers.get("user-agent"));
  const { token, id } = await createToken(uid, label);
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
