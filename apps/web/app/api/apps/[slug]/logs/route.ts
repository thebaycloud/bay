export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getLogs, ownsApp } from "@/lib/gcloud";
import { currentUserId } from "@/lib/session";

export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ logs: [], error: "forbidden" }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  try {
    const logs = await getLogs(slug, {
      limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
      severity: sp.get("severity") ?? undefined,
      freshness: sp.get("since") ?? undefined,
    });
    return Response.json({ logs });
  } catch (e) {
    return Response.json({ logs: [], error: e instanceof Error ? e.message : String(e) });
  }
}
