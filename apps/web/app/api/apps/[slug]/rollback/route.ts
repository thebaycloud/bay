export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";
import { previousReleaseId, releasesFor } from "@/lib/rollback";
import { desiredRelease, setDesired } from "@/lib/reconcile";
import { deployTargetForApp } from "@/lib/deploy-target";

/**
 * Roll back to the previous version: ONE WRITE, and the reconciler does the rest.
 *
 * This used to answer 501, and the reason it gave was true when it was written —
 * "a placement keeps only the current version" — and is not any more. `releases`
 * holds every version with the spec that shipped, `fleet_placements` copies that
 * spec byte-for-byte when it places, and `planPlacements` converges on whatever
 * `desired_release` names without caring whether it is newer or older than what
 * is running. So the older version is RE-PLACED from the row that recorded it,
 * never rebuilt.
 *
 * It is also why nothing here waits: the roll is the reconciler's, and it is the
 * same roll a deploy gets — place beside, wait for the node to report ready,
 * drain the old. Holding the request open would be a second implementation of a
 * sequence that already exists, and one that dies with the connection.
 */
export async function POST(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ error: "forbidden" }, { status: 403 });

  // Asked of the target rather than re-derived here, which is what lib/deploy-target.ts
  // exists for. It answers no for a static app: that is files in a bucket, with
  // no release history and nothing to place.
  const target = await deployTargetForApp(slug);
  if (!target.supports("rollback")) {
    return Response.json(
      { error: "this app is published as static files, which have no versions to roll between" },
      { status: 501 },
    );
  }

  try {
    const [desired, releases] = await Promise.all([desiredRelease(slug), releasesFor(slug)]);
    const previous = previousReleaseId(releases, desired);
    if (previous === null) {
      // Separated from a failure on purpose: an app with one version is not
      // broken, it simply has nowhere to go. 409 rather than 501 — the mechanism
      // exists now, this app just has no earlier release for it to act on.
      return Response.json(
        {
          error: releases.length <= 1
            ? "this app has only ever had one version, so there is nothing behind it"
            : "this app is already on its earliest recorded version",
        },
        { status: 409 },
      );
    }

    await setDesired(slug, previous);
    const version = releases.find((r) => r.id === previous)?.version ?? null;
    return Response.json({
      ok: true,
      release: previous,
      version,
      // Said in the answer rather than left to be discovered. The spec is
      // explicit that this is a rollback of CODE and not of schema: a release
      // that ran a migration is not undone by pointing at an older image, and
      // the older code will start against the newer database.
      note: "this rolls back code, not the database — a migration the newer version ran is still applied",
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
