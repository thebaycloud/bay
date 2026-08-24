export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { describeService } from "@/lib/gcloud";
import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";
import { getAppBySlug } from "@/lib/apps";
import { getDeploy } from "@/lib/deploys";
import { placementFor, runningOnNode } from "@/lib/fleet";
import { statusFromFleet } from "@/lib/app-status";
import { deployTargetForApp } from "@/lib/deploy-target";
import { appUrl } from "@/lib/brand";

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

  /**
   * WHERE THIS APP CAME FROM, read once and answered the same by every branch.
   *
   * `supersonic redeploy` reads this field and dies without it. Its message was
   * right for an upload and wrong for everything else: `repo` used to come from a
   * `SUPERSONIC_REPO` environment variable on the Cloud Run SERVICE, so an app
   * running on a node had no service to read it from and redeploy refused every
   * app on the fleet with "was deployed from a computer".
   *
   * The row is the right source precisely because it is not the runtime. Where
   * an app came from does not change when it moves, and the three branches below
   * — fleet, Cloud Run, and the row alone — must not be able to disagree about it.
   *
   * "" and not undefined when unknown: the CLI's `if (!d.repo)` cannot tell them
   * apart, but the field being absent and being empty read differently to
   * everything else, and an app uploaded as a folder genuinely has none.
   */
  const repo = (await getAppBySlug(slug).catch(() => null))?.repo_url ?? "";

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
    const target = await deployTargetForApp(slug);
    if (target.kind === "fleet") {
      const placed = await placementFor(slug);
      if (placed) {
        const running = await runningOnNode(slug, placed.node);
        return Response.json({
          ...statusFromFleet(slug, placed.spec, running),
          repo,
          deploying,
          stage: deploy?.stage ?? "",
        });
      }
    }
  } catch {
    // fall through to Cloud Run
  }

  try {
    // `repo` LAST, so the row wins over the service's `SUPERSONIC_REPO`. The env
    // var is whatever was set when the service was last deployed; the row is
    // maintained by every deploy since the column existed.
    return Response.json({ ...(await describeService(slug)), repo, deploying, stage: deploy?.stage ?? "" });
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
      url: appUrl(slug),
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
      repo,
      served: "static",
    });
  }
}
