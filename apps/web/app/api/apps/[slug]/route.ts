export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { describeService } from "@/lib/gcloud";
import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";
import { getAppBySlug } from "@/lib/apps";
import { getDeploy } from "@/lib/deploys";
import { runtimeOf, placementFor, runningOnNode } from "@/lib/fleet";
import { statusFromFleet } from "@/lib/app-status";

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ error: "forbidden" }, { status: 403 });
  // "Ready or down" has no way to say "still coming", so an app mid-deploy was
  // reported as down — `○ down`, `revision —`, `env none` — while its build was
  // running normally and its URL was answering 200. Every one of those readings
  // was a confident answer to a question the platform could not yet answer.
  const deploy = await getDeploy(slug).catch(() => null);
  const deploying = deploy?.status === "building";

  // WHERE the app runs, before anything else is asked.
  //
  // This route used to go straight to Cloud Run, and for a fleet app that is
  // wrong in two different ways. With no Cloud Run service it fell through to
  // the static branch below and reported empty revision, empty image and no env
  // for an app that was serving — the shape of every app deployed since the
  // fleet became the default target. With a STALE service left behind by the
  // move it answered FROM that service, and reported `ready: false` for an app
  // that is up, because an abandoned revision cannot start. Blank reads as "not
  // known yet"; wrong-but-plausible sends someone to debug an app that is fine.
  //
  // Best-effort: any failure here falls through to exactly the old path, so a
  // fleet table that cannot be read costs the extra detail and nothing else.
  try {
    if ((await runtimeOf(slug)) === "fleet") {
      const placed = await placementFor(slug);
      if (placed) {
        const running = await runningOnNode(slug, placed.node);
        return Response.json({
          ...statusFromFleet(slug, placed.node, placed.spec, running),
          deploying,
          stage: deploy?.stage ?? "",
        });
      }
    }
  } catch {
    // fall through to Cloud Run
  }

  try {
    return Response.json({ ...(await describeService(slug)), deploying, stage: deploy?.stage ?? "" });
  } catch {
    // No Cloud Run service of its own. That is the normal, healthy shape of a
    // static app — it is served by the shared static service — and also of an app
    // whose build has not landed yet. Answer from the row we do have instead of
    // 404-ing, which read as "your app is gone" for a site that was up the whole
    // time.
    const app = await getAppBySlug(slug).catch(() => null);
    if (!app) return Response.json({ error: "no such app" }, { status: 404 });
    return Response.json({
      slug,
      name: slug,
      url: `https://${slug}.supersonic.cv`,
      ready: app.status === "live",
      status: app.status,
      deploying,
      stage: deploy?.stage ?? "",
      region: "us-central1",
      // Everything below belongs to a container, and a static app has none of it.
      // Empty is the honest answer; the CLI already prints "—" for these.
      revision: "",
      image: "",
      envKeys: [],
      cloudsql: "",
      repo: "",
      served: "static",
    });
  }
}
