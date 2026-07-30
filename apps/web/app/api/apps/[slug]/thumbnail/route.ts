export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { currentUserId } from "@/lib/session";
import { getAppBySlug } from "@/lib/apps";
import { readThumbnail, requestThumbnail } from "@/lib/thumbnail";
import { ASSETS_BUCKET } from "@/lib/static-release";

/**
 * Slugs we have already asked the screenshot service about, so a dashboard with
 * twelve thumbnail-less cards asks for twelve screenshots and not twelve per
 * reload. Per-instance and deliberately not persisted: the cost of forgetting is
 * one extra screenshot.
 */
const asked = new Map<string, number>();
const ASK_INTERVAL_MS = 10 * 60_000;

function shouldAsk(slug: string): boolean {
  const now = Date.now();
  const last = asked.get(slug) ?? 0;
  if (now - last < ASK_INTERVAL_MS) return false;
  asked.set(slug, now);
  return true;
}

/**
 * The screenshot behind an app card.
 *
 * Served through here rather than from a public bucket, because a screenshot of a
 * private app is a picture of private content — making the bucket world-readable
 * would hand out what the app itself refuses to show. Ownership is checked on every
 * request; the browser's own cache does the rest.
 */
export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const uid = await currentUserId();
  if (!uid) return new Response("not signed in", { status: 401 });

  const slug = decodeURIComponent(params.slug);
  const app = await getAppBySlug(slug);
  if (!app || app.owner_id !== uid) return new Response("not found", { status: 404 });

  const image = await readThumbnail(ASSETS_BUCKET, slug);
  if (!image) {
    // Apps deployed before the screenshot service existed have no picture, and
    // waiting for their next deploy would leave the dashboard bare for good. Ask
    // for one now and answer 404 — the card shows its monogram, and the next load
    // finds the image. Not awaited: nobody should wait on a browser starting up.
    if (app.status === "live" && app.run_url && shouldAsk(slug)) void requestThumbnail(slug, app.run_url);
    return new Response("no thumbnail", { status: 404 });
  }

  return new Response(new Uint8Array(image), {
    headers: {
      "content-type": "image/jpeg",
      // Short and private: the picture changes on every deploy, and it belongs to
      // one person. A shared cache must never hold it.
      "cache-control": "private, max-age=300",
    },
  });
}
