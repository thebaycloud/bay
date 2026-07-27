export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { cloudRunName } from "@/lib/slug";
import { currentUserId } from "@/lib/session";
import { resolveSlug } from "@/lib/gcloud";
import { liveReleaseHash } from "@/lib/apps";

/**
 * "Is this exact build already live?"
 *
 * The CLI hashes what it built and asks before uploading. A match means there is
 * nothing to do — the deploy is finished in about a second instead of eighty.
 *
 * This is a separate call rather than a header on the deploy itself because HTTP gives
 * no way to abandon a request body once it is being sent: by the time the server could
 * answer, the upload has already happened.
 *
 * Answering "no" is always safe. Any failure here — an unknown app, a database hiccup,
 * an older client — must land on the ordinary upload path, never on a wrong skip.
 */
export async function POST(req: Request) {
  const ownerId = await currentUserId();
  if (!ownerId) return Response.json({ error: "not signed in" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const hash = String(body.hash ?? "").trim().toLowerCase();
  const app = String(body.app ?? "").trim();
  if (!/^[a-f0-9]{64}$/.test(hash) || !app) {
    return Response.json({ skip: false }, { status: 200 });
  }

  try {
    // resolveSlug maps this owner's friendly name onto the slug their app already
    // has, so a redeploy is compared against the right app rather than a stranger's.
    const slug = await resolveSlug(ownerId, cloudRunName(app));
    const live = await liveReleaseHash(slug, ownerId);
    if (live && live === hash) {
      return Response.json({ skip: true, slug, url: `https://${slug}.supersonic.cv` });
    }
    return Response.json({ skip: false, slug });
  } catch {
    return Response.json({ skip: false });
  }
}
