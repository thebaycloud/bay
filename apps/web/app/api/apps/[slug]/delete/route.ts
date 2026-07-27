export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { deleteApp, ownsApp } from "@/lib/gcloud";
import { currentUserId } from "@/lib/session";

export async function POST(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ error: "forbidden" }, { status: 403 });
  try {
    await deleteApp(slug);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
