export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getAppBySlug, setAnalyticsEnabled } from "@/lib/apps";
import { websiteStatsCached } from "@/lib/umami";
import { currentUserId } from "@/lib/session";
import { corsFor, optionsHandler } from "@/lib/cors";

/**
 * The owner's switch, and nothing else.
 *
 * This is other people's users' data. An owner who does not want their visitors
 * counted has to be able to say so from the same surface that shows them the
 * count — not by filing a ticket, and not by deleting the app. Off stops the
 * injection and stops the reads, both, from the next request onward; what was
 * already collected stays until the app is deleted, which is when its umami
 * site is deleted too.
 *
 * Called from the panel, which is injected into `<slug>.supersonic.cv` and so
 * is a different origin than this one — the same shape as the share route, and
 * the same allowlist of our own subdomains.
 */
export const OPTIONS = optionsHandler;

async function ownedApp(slug: string) {
  const uid = await currentUserId();
  if (!uid) return null;
  const app = await getAppBySlug(slug);
  if (!app || app.owner_id !== uid) return null;
  return app;
}

export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const cors = corsFor(req, slug);
  const app = await ownedApp(slug);
  if (!app) return Response.json({ error: "forbidden" }, { status: 403, headers: cors });
  return Response.json(
    {
      // Two facts, not one. "Off" is the owner's decision; "no site" is ours —
      // an app created before analytics existed, or one whose provisioning call
      // did not land. The panel says different things about them and cannot
      // work out which is which from a single boolean.
      enabled: app.analytics_enabled !== false,
      provisioned: Boolean(app.umami_website_id),
      // The COUNT, from the same reader chat's `analytics` tool uses.
      //
      // The panel used to take its audience half from the app's own `/_xray`, which
      // is assembled by the proxy. So the workbench and chat answered the same
      // question from two different sources and disagreed on screen: chat said "0
      // visitors in the last 30 days" while the Analytics screen beside it said "the
      // analytics service could not be reached". At least one was wrong and showing
      // both is worse than either.
      //
      // `null` is not zero. Unreachable and nobody-came are opposite answers, and the
      // screen says them differently — which it can only do if this stays null rather
      // than collapsing to a count.
      stats: app.umami_website_id && app.analytics_enabled !== false
        ? await websiteStatsCached(app.umami_website_id, "30d")
        : null,
    },
    { headers: cors }
  );
}

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const cors = corsFor(req, slug);
  const app = await ownedApp(slug);
  if (!app) return Response.json({ error: "forbidden" }, { status: 403, headers: cors });

  const body = await req.json().catch(() => ({}));
  if (typeof body.enabled !== "boolean") {
    return Response.json({ error: "enabled must be true or false" }, { status: 400, headers: cors });
  }
  await setAnalyticsEnabled(slug, body.enabled);
  // The edge caches app rows for thirty seconds, so the switch takes effect
  // within that rather than instantly. Said here rather than discovered by an
  // owner who flipped it and reloaded twice.
  return Response.json(
    { enabled: body.enabled, provisioned: Boolean(app.umami_website_id), settlesInSeconds: 30 },
    { headers: cors }
  );
}
