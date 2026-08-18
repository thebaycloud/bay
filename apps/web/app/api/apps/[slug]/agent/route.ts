export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";
import { listTokens, revokeToken } from "@/lib/cli-tokens";
import { withCors, optionsHandler } from "@/lib/cors";

/**
 * How an agent reaches this app, and whether one ever has.
 *
 * `/api/account/tokens` already lists and revokes these, and the panel cannot
 * call it: it is not app-scoped and carries no CORS, so a request from
 * <slug>.supersonic.cv is refused before the handler sees it. This is the same
 * two functions behind the same ownership rule as every other route the panel
 * uses, with the origin check its neighbours have.
 *
 * WHAT last_used_at DOES AND DOES NOT SAY
 *
 * A token belongs to a person, not to an app — one token deploys everything they
 * own. So `lastUsedAt` is the last time that token was used AT ALL, and the panel
 * has to say so in those words. Claiming it as "last used on this app" would be
 * a per-app fact we do not record, and inventing one is how a reading stops being
 * worth trusting.
 */
async function getHandler(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) {
    return Response.json({ error: "forbidden", tokens: [] }, { status: 403 });
  }
  const tokens = await listTokens(uid);
  return Response.json({
    tokens,
    // Said out loud rather than left for the panel to assume. There is no MCP
    // server yet, and a config block for one would point an agent at nothing.
    mcp: false,
  });
}

async function postHandler(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { revoke?: string };
  if (!body.revoke) return Response.json({ error: "missing token id" }, { status: 400 });
  // revokeToken is scoped to the user, so one owner cannot revoke another's token
  // by guessing an id — the ownership check above is about the app, not the token.
  const ok = await revokeToken(uid, body.revoke);
  if (!ok) return Response.json({ error: "token not found" }, { status: 404 });
  return Response.json({ tokens: await listTokens(uid) });
}

// The panel runs on the app's own hostname, so every call here is cross-origin.
// Exactly this app's origin, never every subdomain; see lib/cors.ts.
export const OPTIONS = optionsHandler;
export const GET = withCors(getHandler);
export const POST = withCors(postHandler);
