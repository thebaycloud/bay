export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { listWorkers } from "@/lib/gcloud";
import { getAppBySlug } from "@/lib/apps";
import { currentUserId } from "@/lib/session";

/**
 * An app's background workers, asked for separately.
 *
 * This used to be part of `describeService`, which the app page awaits before it
 * renders anything — and `listWorkers` shells out to `gcloud beta run
 * worker-pools list`, a 1.5–1.7s subprocess that returns nothing for almost
 * every app. Nobody should wait on that to see their app's page.
 *
 * Ownership from the database rather than from Cloud Run's labels: it is one
 * indexed read instead of another API call, and it is also right for apps that
 * have no service at all.
 */
export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid) return Response.json({ error: "not signed in" }, { status: 401 });

  const app = await getAppBySlug(slug);
  if (!app || app.owner_id !== uid) return Response.json({ error: "not found" }, { status: 404 });

  return Response.json({ workers: await listWorkers(slug) });
}
