export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { rollback } from "@/lib/gcloud";
import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";
import { runtimeOf } from "@/lib/fleet";

export async function POST(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ error: "forbidden" }, { status: 403 });
  // Refused rather than performed on the wrong thing. `rollback` moves Cloud Run
  // traffic to the previous REVISION, and an app on a node has none — but a
  // migrated app still has its old service, so this would have succeeded against
  // something nothing routes to and reported a rollback that did not happen.
  //
  // There is nothing to fall back to yet either: a placement holds one spec, not
  // a history, so the previous version is not written down anywhere. Saying so is
  // the honest answer until it is.
  if ((await runtimeOf(slug)) === "fleet") {
    return Response.json(
      { error: "this app runs on a node, where rollback is not wired up yet — a placement keeps only the current version. Redeploy the commit you want." },
      { status: 501 },
    );
  }
  try {
    const revision = await rollback(slug);
    return Response.json({ ok: true, revision });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
