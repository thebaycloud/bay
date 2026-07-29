export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { currentUserId } from "@/lib/session";
import { getAppBySlug } from "@/lib/apps";
import { readThumbnail } from "@/lib/thumbnail";
import { ASSETS_BUCKET } from "@/lib/static-release";

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
  if (!image) return new Response("no thumbnail", { status: 404 });

  return new Response(new Uint8Array(image), {
    headers: {
      "content-type": "image/jpeg",
      // Short and private: the picture changes on every deploy, and it belongs to
      // one person. A shared cache must never hold it.
      "cache-control": "private, max-age=300",
    },
  });
}
