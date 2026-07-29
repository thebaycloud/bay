export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { deleteApp, ownsApp } from "@/lib/gcloud";
import { getAppBySlug } from "@/lib/apps";
import { getPool } from "@/lib/db";
import { currentUserId } from "@/lib/session";

export async function POST(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid) return Response.json({ error: "forbidden" }, { status: 403 });

  // Ownership from the apps table — authoritative for BOTH lanes. The old check
  // asked Cloud Run about a service named <slug>, which static apps don't have,
  // so it 403'd even the real owner. Fall back to the Cloud Run label only for a
  // legacy app with no row.
  const app = await getAppBySlug(slug);
  const owns = app ? app.owner_id === uid : await ownsApp(slug, uid);
  if (!owns) return Response.json({ error: "forbidden" }, { status: 403 });

  try {
    await deleteApp(slug);
    // Remove the row so the app is fully gone (grants + requests cascade). Static
    // apps are tracked only here, so without this they'd linger forever.
    await getPool("supersonic_platform")
      .query("DELETE FROM apps WHERE slug = $1 AND owner_id = $2", [slug, uid])
      .catch(() => {});
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
