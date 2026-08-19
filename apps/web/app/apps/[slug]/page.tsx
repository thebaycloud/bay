import { Suspense } from "react";
import { Cockpit } from "@/components/Cockpit";
import { Workbench, type AppState } from "@/components/Workbench";
import SharePanel from "@/components/SharePanel";
import { CockpitSkeleton, RailSkeleton } from "@/components/Skeleton";
import { describeService, type ServiceInfo } from "@/lib/gcloud";
import { getAppBySlug } from "@/lib/apps";
import { getDeploy } from "@/lib/deploys";
import { currentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Whether this slug has a Cloud Run service of its own.
 *
 * A service is named for its slug, so its URL host starts with it. The other
 * shapes `run_url` holds — the shared static server, a fleet address, nothing at
 * all — belong to infrastructure this app merely sits on, and asking Cloud Run
 * about them fails slowly: measured at 2.9s for a static app, because the REST
 * lookup 404s and the code then shells out to `gcloud run services describe` to
 * be told the same thing again.
 */
function ownsService(slug: string, runUrl: string | null): boolean {
  if (!runUrl) return false;
  try {
    return new URL(runUrl).host.startsWith(`${slug}-`);
  } catch {
    return false;
  }
}

/**
 * The one state the pill shows.
 *
 * `status` is the field that answers doneness — deploys.ts spells it
 * live | building | deploying | pending | failed | canceled, and there is no
 * 'done'. `stage` holds the last step that RAN, so reading it for doneness left
 * every finished app saying "shipping" forever.
 */
function stateOf(status: string | null | undefined, ready: boolean): AppState {
  const s = String(status ?? "");
  if (s === "failed" || s === "canceled") return "broken";
  if (s === "building" || s === "deploying" || s === "pending") return "shipping";
  return ready ? "live" : "shipping";
}

/** What the cockpit needs for an app whose facts live in our database, not in Cloud Run. */
function fromRecord(slug: string, name: string, uid: string, ready: boolean): ServiceInfo {
  return {
    slug, name, url: `https://${slug}.supersonic.cv`, ready,
    region: "us-central1", created: "", revision: "", image: "",
    envKeys: [], cloudsql: "", repo: "", storageBucket: "", owner: uid,
  };
}

/**
 * The shell goes out first.
 *
 * Everything below this boundary waits on Postgres and, for an app with its own
 * Cloud Run service, on Cloud Run — a second or more before there is anything to
 * look at. Streaming means the rail and the frame are on screen while that
 * happens, instead of a blank tab.
 */
export default function AppPage({ params }: { params: { slug: string } }) {
  return (
    <Suspense fallback={<div className="shell shell-side"><RailSkeleton /><CockpitSkeleton /></div>}>
      <AppData params={params} />
    </Suspense>
  );
}

async function AppData({ params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid) return notYours();

  // The database first, and it answers three questions Cloud Run was being asked
  // for: does this app exist, is it yours, and does it even have a service. Only
  // the third one needs an API call afterwards.
  const app = await getAppBySlug(slug);
  if (app && app.owner_id !== uid) return notYours();

  if (app && ownsService(slug, app.run_url)) {
    let data: ServiceInfo | null = null;
    try { data = await describeService(slug); } catch { data = null; }
    if (data && data.owner === uid) {
      return (
        <Workbench slug={slug} address={`${slug}.supersonic.cv`} state={stateOf(app.status, data.ready)}>
          <Cockpit appName={slug} data={data}>
            <SharePanel slug={slug} />
          </Cockpit>
        </Workbench>
      );
    }
  }

  // Static apps, fleet apps, and an app whose first deploy has not produced a
  // service yet: everything on this page comes from our own records. The
  // deploy record carries the name the person deployed under.
  const dep = await getDeploy(slug);
  if (app || dep) {
    const name = dep?.name || app?.slug || slug;
    const ready = app?.status === "live";
    return (
      <Workbench slug={slug} address={`${slug}.supersonic.cv`} state={stateOf(app?.status ?? dep?.status, ready)}>
        <Cockpit appName={slug} data={fromRecord(slug, name, uid, ready)}>
          <SharePanel slug={slug} />
        </Cockpit>
      </Workbench>
    );
  }

  return notYours();
}

function notYours() {
  return (
    <div className="authpage">
      <div className="authbox">
        <div className="authbrand">SUPERSONIC</div>
        <h1>Not found</h1>
        <p className="authalt">This app doesn&apos;t exist or isn&apos;t yours. <a href="/">Back to your apps</a></p>
      </div>
    </div>
  );
}
