export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { deleteApp } from "@/lib/gcloud";
import { getAppBySlug } from "@/lib/apps";
import { getPool } from "@/lib/db";
import { deleteDeploy, deployOwner } from "@/lib/deploys";
import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";
import { unplaceApp } from "@/lib/fleet";
import { supersedeRunsFor } from "@/lib/deploy-runs";

export async function POST(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid) return Response.json({ error: "forbidden" }, { status: 403 });

  // Ownership from the apps table — authoritative for BOTH lanes. The old check
  // asked Cloud Run about a service named <slug>, which static apps don't have,
  // so it 403'd even the real owner. Fall back to the Cloud Run label only for a
  // legacy app with no row.
  const app = await getAppBySlug(slug);
  // Third fallback: the deploy record's owner.
  //
  // A delete that partly succeeded — apps row gone, deploy row left behind — was
  // unrecoverable without it. getAppBySlug finds nothing, there is no Cloud Run
  // service to carry an owner label, so ownership could not be established and
  // every retry returned "forbidden". The leftovers then stay forever, and the
  // dashboard keeps rendering an app that does not exist. The one identity still
  // recorded for the slug is on the deploy row.
  const owns = app ? app.owner_id === uid
    : (await ownsApp(slug, uid)) || (await deployOwner(slug)) === uid;
  if (!owns) return Response.json({ error: "forbidden" }, { status: 403 });

  try {
    // Stop the deploy that is running right now, before anything is torn down.
    //
    // Deleting an app never touched `deploy_runs`, so a delete during a build
    // left the build running against an app that no longer existed. Three
    // consequences, all of them observed on 10 Aug while benchmarking:
    //
    //  - the job keeps going and can recreate the very resources this call is
    //    deleting, seconds after it deletes them. `bench/cleanup.ts` documents
    //    orphans nobody could explain — services and databases with no row to
    //    account for them — and a deploy that outlived its own delete is one way
    //    to manufacture exactly that.
    //  - the row counts against the owner's concurrent-deploy cap until it ages
    //    out an hour later, so "you already have N deploys building" names
    //    deploys of apps that have been deleted.
    //  - the row holds the app's secrets. `finishRun` exists to bound how long
    //    those sit in the database; a killed or abandoned run bounds them at
    //    `pruneRuns`'s six hours instead, and deleting the app did not shorten
    //    that by a second.
    //
    // `supersedeRunsFor` is the function that already does this correctly —
    // deletes the rows first so nothing can find the run again, then cancels the
    // execution on the Job and on the warm worker. It was simply never called
    // from here. Best-effort like everything else below: a deploy that cannot be
    // cancelled must not turn "delete my app" into a 500.
    await supersedeRunsFor(slug).catch(() => {});
    await deleteApp(slug);
    // Remove the row so the app is fully gone (grants + requests cascade). Static
    // apps are tracked only here, so without this they'd linger forever.
    await getPool("supersonic_platform")
      .query("DELETE FROM apps WHERE slug = $1 AND owner_id = $2", [slug, uid])
      .catch(() => {});
    // And its deploy history. Left behind, a row still reading 'building' keeps
    // the dashboard showing "Deploying…" for an app that no longer exists.
    await deleteDeploy(slug);
    // And its fleet placement, on every node — not just the one it last ran
    // on. Left behind, the row outlives the app: slugs are five characters
    // and get re-issued (see lib/gcloud.ts's own reasoning for databases and
    // image caches), and a freed slug taken by a new app that also lands on
    // the fleet hands its node the previous tenant's spec. Swallowed like the
    // row deletion above — an app that was never on the fleet has nothing to
    // clear, and a hiccup here must not turn "delete my app" into a 500 for
    // everything else this call already did.
    await unplaceApp(slug).catch(() => {});
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
