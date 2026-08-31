export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { currentUserId } from "@/lib/session";
import { createToken, listTokens, revokeToken } from "@/lib/cli-tokens";
import { browserLabel } from "@/lib/client-label";
import { recordFirstTouch } from "@/lib/acquisition";

// Mint a CLI token for the signed-in user (browser session cookie).
export async function POST(req: Request) {
  const uid = await currentUserId();
  if (!uid) return Response.json({ error: "not signed in" }, { status: 401 });
  const { name, via } = await req.json().catch(() => ({}));
  // The CLI names the machine — `os.hostname()`, so "MacBook-Pro-3.local". A
  // browser names nothing, and the fallback was the literal "cli", which made
  // every hand-made token identical in a list whose job is telling them apart.
  // Derived HERE rather than in the page: the header is already on the request,
  // and one implementation cannot drift from another.
  const label = String(name || "").trim() || browserLabel(req.headers.get("user-agent"));
  const { token, id } = await createToken(uid, label);
  // How this account arrived, if the terminal that opened this page knew. First
  // touch only — a second machine signing in to an existing account is told
  // `recorded: false` and the page then says nothing about it, because the value
  // it carried was discarded. Never allowed to fail the mint: the token above is
  // already real, and an account that cannot finish signing in over an analytics
  // column would be a self-inflicted outage.
  const recorded = await recordFirstTouch(uid, via);
  return Response.json({ token, id, recorded });
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
