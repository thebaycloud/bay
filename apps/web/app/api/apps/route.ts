export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { listServices } from "@/lib/gcloud";
import { listActiveDeploys } from "@/lib/deploys";
import { currentUserId } from "@/lib/session";

export async function GET() {
  const uid = await currentUserId();
  if (!uid) return Response.json({ apps: [], error: "not signed in" }, { status: 401 });
  try {
    const [apps, deploys] = await Promise.all([listServices(uid), listActiveDeploys(uid)]);
    const liveSlugs = new Set(apps.map((a) => a.slug));
    // In-flight deploys that don't have a live Cloud Run service yet — shown as
    // "building" cards so the dashboard reflects deploys started anywhere (CLI too).
    const building = deploys
      .filter((d) => !liveSlugs.has(d.slug))
      .map((d) => ({
        slug: d.slug, name: d.name || d.slug, url: "", ready: false,
        region: "us-central1", image: "", owner: uid,
        status: "building" as const, stage: d.stage || "deploying…",
      }));
    return Response.json({ apps: [...building, ...apps] });
  } catch (e) {
    return Response.json({ apps: [], error: e instanceof Error ? e.message : String(e) });
  }
}
