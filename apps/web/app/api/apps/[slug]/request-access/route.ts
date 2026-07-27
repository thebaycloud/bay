export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getAppBySlug } from "@/lib/apps";
import { getPool } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { currentUserId } from "@/lib/session";

const DB = "supersonic_platform";

// Same-subdomain-only CORS: the request button lives on <slug>.supersonic.cv.
function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  try {
    const h = new URL(origin).hostname;
    if (h === "supersonic.cv" || h.endsWith(".supersonic.cv")) {
      return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        Vary: "Origin",
      };
    }
  } catch { /* same-origin */ }
  return {};
}

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: cors(req) });
}

async function emailOf(userId: string): Promise<string | null> {
  const r = await getPool(DB).query("SELECT email FROM users WHERE id = $1", [userId]);
  return r.rows[0]?.email ?? null;
}

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const headers = cors(req);
  const slug = decodeURIComponent(params.slug);

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

  const link = `https://app.supersonic.cv/apps/${slug}`;
  const result = await sendEmail({
    to: owner,
    subject: `${requester ?? "Someone"} is requesting access to ${slug}`,
    text: `${requester ?? "Someone"} asked for access to your app "${slug}".\n\nGrant or deny it from your app's Share settings:\n${link}`,
  });

  if (!result.ok) return Response.json({ error: "couldn't send the request" }, { status: 502, headers });
  return Response.json({ ok: true }, { headers });
}
