export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { describeService } from "@/lib/gcloud";
import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";
import { getAppBySlug } from "@/lib/apps";
import { getDeploy } from "@/lib/deploys";

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
