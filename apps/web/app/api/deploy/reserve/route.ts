export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reserve a slug up front — the URL-first half of instant deploys.
 *
 * The dashboard/CLI calls this the moment a deploy starts, gets back
 * `<slug>.supersonic.cv`, and can show it (or open the tunnel to it) immediately,
 * before a single byte is built. The real deploy then runs against the SAME slug
 * (pass it back as `body.slug` to /api/deploy) and publishes onto it.
 */
import { currentUserId } from "@/lib/session";
import { resolveSlug } from "@/lib/gcloud";
import { createAppRecord } from "@/lib/apps";
import { cloudRunName } from "@/lib/slug";
import { getPool } from "@/lib/db";
import { setDeploy } from "@/lib/deploys";
import { entitlement, countOwnerApps } from "@/lib/entitlements";
import { usageFor } from "@/lib/usage";
import { appLimitMessage, buildLimitMessage, noAccountMessage } from "@/lib/plan-copy";
import { inFlightForOwner, runIdsForSlug } from "@/lib/deploy-runs";

export async function POST(req: Request) {
  const uid = await currentUserId();
  if (!uid) return Response.json({ error: "not signed in" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? body.repo ?? "app").trim() || "app";
  const friendly = cloudRunName(name);
  const slug = await resolveSlug(uid, friendly);

  // The plan gate belongs HERE, not only in /api/deploy. This endpoint is what
  // makes the CLI print "✓ your app is live at <url>"; the build then runs in a
  // detached worker whose output nobody reads. A user over their app limit got the
  // success line, a URL, and a "building…" page that answered 200 forever, while
  // the actual refusal sat in ~/.supersonic/deploys/<slug>.log. Refuse before we
  // promise anything.
  const ent = await entitlement(uid);
  if (ent.locked) {
    return Response.json({ error: noAccountMessage(), paywall: true, reason: "no_account" }, { status: 402 });
  }
  if (Number.isFinite(ent.limits.maxApps) && (await countOwnerApps(uid, slug)) >= ent.limits.maxApps) {
    return Response.json({ error: appLimitMessage(ent.limits), upgrade: true, reason: "app_limit" }, { status: 402 });
  }

  // The build meter, read but NOT incremented.
  //
  // Advisory by construction: /api/deploy takes the count atomically when it
  // dispatches the job, and taking it here as well would charge two builds for
  // every deploy — or one for a reservation that never became a build at all,
  // which is what happens every time somebody opens the new-app page and
  // changes their mind. The race this leaves open is a user at 29 of 30 firing
  // two deploys at once and being told "go ahead" twice; the second is then
  // refused a moment later by the authoritative check, which is the right
  // failure and costs nothing.
  if (Number.isFinite(ent.limits.monthlyBuilds)) {
    const used = (await usageFor(uid)).builds;
    if (used >= ent.limits.monthlyBuilds) {
      return Response.json({ error: buildLimitMessage(ent.limits), upgrade: true, reason: "build_limit" }, { status: 402 });
    }
  }

  // Refused visibly, rather than experienced as a hang.
  //
  // This is the endpoint that already turns away an over-limit deploy before the
  // CLI promises anything, which is the whole reason the cap belongs here: past
  // this point dispatch is fire-and-forget `--async`, and a queued build is
  // indistinguishable from a slow app in the CLI. Worse, `deploy-errors.ts`
  // classifies `quota|rate limit|resource exhausted` as platform blame, so a
  // deploy that lost a race for the shared build pool would never reach repair
  // and the user would see a generic stall.
  //
  // A redeploy of the SAME app is exempt: `supersedeRunsFor` cancels the previous
  // one, so pushing twice in a row is one deploy replacing another rather than
  // two competing, and counting it would refuse the most ordinary thing a person
  // does after a failed build.
  const inFlight = await inFlightForOwner(uid);
  const mine = (await runIdsForSlug(slug)).length;
  if (Number.isFinite(ent.limits.maxConcurrentDeploys) && inFlight - mine >= ent.limits.maxConcurrentDeploys) {
    return Response.json(
      {
        error: `You already have ${inFlight - mine} deploys building. `
          + `Wait for one to finish — they are queued behind a shared build pool, and starting more makes all of them slower.`,
      },
      { status: 429 },
    );
  }

  const workspaceId = (await getPool("supersonic_platform").query(
    "SELECT workspace_id FROM users WHERE id = $1", [uid]
  )).rows[0]?.workspace_id ?? null;
  if (workspaceId) {
    await createAppRecord({ slug, workspaceId, ownerId: uid });
    setDeploy(slug, { ownerId: uid, name: friendly, status: "building", stage: "reserved" });
  }

  return Response.json({ slug, url: `https://${slug}.supersonic.cv`, name: friendly });
}
