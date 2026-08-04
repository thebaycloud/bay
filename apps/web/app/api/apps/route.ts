export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { listOwnedApps } from "@/lib/apps";
import { listActiveDeploys, lastDeploySummaries } from "@/lib/deploys";
import { currentUserId } from "@/lib/session";

/**
 * The dashboard's app list.
 *
 * Answered from the database, not from Cloud Run. Listing Cloud Run meant fetching
 * every service in the project and filtering by owner label afterwards, so opening
 * the dashboard got slower for everyone each time anybody deployed anything — and
 * it missed static apps entirely, because those have no service of their own.
 *
 * Cloud Run still knows things this does not — the live revision, the image, the
 * region — but none of them belong on a list card. They are fetched per app, on the
 * page that shows them.
 */
export async function GET() {
  const uid = await currentUserId();
  if (!uid) return Response.json({ apps: [], error: "not signed in" }, { status: 401 });
  try {
    // The same three reads the server render does. This route is what the
    // dashboard polls while something is building, and it replaces the whole
    // list — so anything the first render has and this does not VANISHES from
    // every row the moment a deploy starts. That is exactly what happened to
    // the "deployed" line, which the server had and this route did not.
    const [apps, deploys, last] = await Promise.all([
      listOwnedApps(uid), listActiveDeploys(uid), lastDeploySummaries(uid),
    ]);
    const known = new Set(apps.map((a) => a.slug));
    // Deploys that have not written an apps row yet — shown as "building" cards so
    // the dashboard reflects a deploy started anywhere, the CLI included.
    const building = deploys
      .filter((d) => !known.has(d.slug))
      .map((d) => ({
        slug: d.slug,
        name: d.name || d.slug,
        url: `https://${d.slug}.supersonic.cv`,
        ready: false,
        region: "us-central1",
        image: "",
        owner: uid,
        status: "building" as const,
        stage: d.stage || "deploying…",
      }));

    return Response.json({
      apps: [
        ...building,
        ...apps.map((a) => ({
          ...a,
          region: "us-central1",
          image: "",
          owner: uid,
          deployedAt: last[a.slug]?.at,
          deployMs: last[a.slug]?.durationMs ?? undefined,
          // A row still marked deploying is in flight, and the card should say so
          // rather than showing it as a finished app that happens to be down.
          status: a.status === "deploying" ? ("building" as const) : undefined,
          stage: a.status === "deploying" ? "deploying…" : undefined,
        })),
      ],
    });
  } catch (e) {
    return Response.json({ apps: [], error: e instanceof Error ? e.message : String(e) });
  }
}
