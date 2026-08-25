export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getAppBySlug } from "@/lib/apps";
import { getPool } from "@/lib/db";
import { sendAccessRequested } from "@/lib/emails";
import { addRequest } from "@/lib/requests";
import { currentUserId } from "@/lib/session";
import { corsFor } from "@/lib/cors";

const DB = "supersonic_platform";

/**
 * `lib/cors.ts`, which this route was not using.
 *
 * It had its own copy of the rule and got it wrong in the one way that file
 * exists to warn about: `h.endsWith(".supersonic.cv")` allows EVERY tenant's
 * subdomain, and every one of those origins is somebody else's JavaScript
 * running on our cookie domain. With `Allow-Credentials: true` reflected back,
 * any hosted app could POST here as whoever opened it.
 *
 * `corsFor` is an exact match — `<slug>.<root>` or `app.<root>`, over every root
 * — so an app reaches its own request-access endpoint and no other app's. Which
 * is all the button on the 403 page needs.
 *
 * The migration is what surfaced it: the check had to learn `thebay.cloud`
 * either way, and widening a suffix test to two roots doubles the wrong thing.
 */
function cors(req: Request, slug: string): Record<string, string> {
  const allowed = corsFor(req, slug);
  if (!allowed["Access-Control-Allow-Origin"]) return {};
  return { ...allowed, "Access-Control-Allow-Methods": "POST, OPTIONS" };
}

export async function OPTIONS(req: Request, { params }: { params: { slug: string } }) {
  return new Response(null, { status: 204, headers: cors(req, decodeURIComponent(params.slug)) });
}

async function emailOf(userId: string): Promise<string | null> {
  const r = await getPool(DB).query("SELECT email FROM users WHERE id = $1", [userId]);
  return r.rows[0]?.email ?? null;
}

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const headers = cors(req, slug);

  // The visitor must be signed in — the proxy sends anonymous users to log in
  // first, so we always know who is asking.
  const uid = await currentUserId();
  if (!uid) return Response.json({ error: "please sign in first" }, { status: 401, headers });

  const app = await getAppBySlug(slug);
  if (!app) return Response.json({ error: "app not found" }, { status: 404, headers });

  // The owner never needs to request access to their own app.
  if (app.owner_id === uid) return Response.json({ ok: true }, { headers });

  const [requester, owner] = await Promise.all([emailOf(uid), emailOf(app.owner_id)]);
  if (!owner) return Response.json({ error: "couldn't reach the owner" }, { status: 500, headers });

  // Record it so the owner can approve/deny from the Share panel, not just email.
  if (requester) await addRequest(app.id, requester);

  const result = await sendAccessRequested({
    ownerEmail: owner,
    ownerId: app.owner_id,
    requester: requester ?? null,
    slug,
  });

  if (!result.ok) return Response.json({ error: "couldn't send the request" }, { status: 502, headers });
  return Response.json({ ok: true }, { headers });
}
