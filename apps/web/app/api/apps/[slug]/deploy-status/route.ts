export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getDeploy } from "@/lib/deploys";
import { ownsApp } from "@/lib/gcloud";
import { currentUserId } from "@/lib/session";

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  // During a first-ever deploy there may be no Cloud Run service yet, so we can't
  // always check ownership via the service — fall back to the deploy row's owner.
  const row = await getDeploy(slug);
  if (!uid) return Response.json({ error: "forbidden" }, { status: 403 });
  const owns = await ownsApp(slug, uid).catch(() => false);
  if (!owns && !row) return Response.json({ deploy: null });
  return Response.json({ deploy: row });
}
