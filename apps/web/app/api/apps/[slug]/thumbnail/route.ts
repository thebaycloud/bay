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
 * request.
 *
 * What that privacy costs is a double transfer: the image comes down from GCS to
 * this server and goes out again to the browser. Measured at 0.8–2.4s per card,
 * twenty-six times, on a dashboard load. Two things make it stop mattering:
 *
 *   - Bytes are held here briefly, so twenty-six cards, a reload, and a second
 *     tab do not each pull the same object out of storage.
 *   - The URL carries the deploy it belongs to (`?v=`), so the answer can be
 *     cached by the browser for a day instead of five minutes. A new deploy is a
 *     new URL, which is what makes a long cache safe rather than stale.
 */
/**
 * Recently served images, so the second card asking is free.
 *
 * Small and per-instance on purpose: it exists to collapse the burst a single
 * dashboard load makes, not to be a CDN. Entries are bytes, so the count is
 * what bounds the memory — a screenshot is tens of kilobytes.
 */
const bytes = new Map<string, { at: number; buf: Buffer }>();
const BYTES_TTL_MS = 10 * 60_000;
const BYTES_MAX = 60;

function remembered(slug: string): Buffer | null {
  const hit = bytes.get(slug);
  if (!hit || Date.now() - hit.at > BYTES_TTL_MS) return null;
  return hit.buf;
}

function remember(slug: string, buf: Buffer): void {
  // Oldest out first. A Map iterates in insertion order, so the first key is
  // the oldest entry and deleting it is the whole eviction policy.
  if (bytes.size >= BYTES_MAX) {
    const oldest = bytes.keys().next().value;
    if (oldest) bytes.delete(oldest);
  }
  bytes.set(slug, { at: Date.now(), buf });
}
export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const uid = await currentUserId();
  if (!uid) return new Response("not signed in", { status: 401 });

  const slug = decodeURIComponent(params.slug);
  const app = await getAppBySlug(slug);
  if (!app || app.owner_id !== uid) return new Response("not found", { status: 404 });

  const image = remembered(slug) ?? await readThumbnail(ASSETS_BUCKET, slug);
  if (!image) {
    // Apps deployed before the screenshot service existed have no picture, and
    // waiting for their next deploy would leave the dashboard bare for good. Ask
    // for one now and answer 404 — the card shows its monogram, and the next load
    // finds the image. Not awaited: nobody should wait on a browser starting up.
    if (app.status === "live" && app.run_url && shouldAsk(slug)) void requestThumbnail(slug, app.run_url);
    return new Response("no thumbnail", { status: 404 });
  }

  remember(slug, image);

  // `immutable` is honest here BECAUSE the URL is versioned by the deploy: this
  // exact URL will never point at a different picture. Private, because the
  // picture belongs to one person and a shared cache must never hold it.
  const versioned = new URL(_req.url).searchParams.has("v");
  return new Response(new Uint8Array(image), {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": versioned ? "private, max-age=86400, immutable" : "private, max-age=300",
    },
  });
}
