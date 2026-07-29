export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reserve a slug up front — the URL-first half of instant deploys.
 *
 * The dashboard/CLI calls this the moment a deploy starts, gets back
 * `<slug>.supersonic.cv`, and can show it (or open the tunnel to it) immediately,
 * before a single byte is built. The real deploy then runs against the SAME slug
 * (pass it back as `body.slug` to /api/deploy) and publishes onto it.
 */
import { currentUserId } from "@/lib/session";
import { resolveSlug } from "@/lib/gcloud";
import { createAppRecord } from "@/lib/apps";
import { cloudRunName } from "@/lib/slug";
import { getPool } from "@/lib/db";
import { setDeploy } from "@/lib/deploys";

export async function POST(req: Request) {
  const uid = await currentUserId();
  if (!uid) return Response.json({ error: "not signed in" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? body.repo ?? "app").trim() || "app";
  const friendly = cloudRunName(name);
  const slug = await resolveSlug(uid, friendly);

  const workspaceId = (await getPool("supersonic_platform").query(
    "SELECT workspace_id FROM users WHERE id = $1", [uid]
  )).rows[0]?.workspace_id ?? null;
  if (workspaceId) {
    await createAppRecord({ slug, workspaceId, ownerId: uid });
    setDeploy(slug, { ownerId: uid, name: friendly, status: "building", stage: "reserved" });
  }

  return Response.json({ slug, url: `https://${slug}.supersonic.cv`, name: friendly });
}
