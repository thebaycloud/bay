export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { probeApp } from "@/lib/probe-run";
import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";

/**
 * Ask the app itself, once, and report what it said.
 *
 * The dashboard's Live/Down is `ready`, which is Cloud Run's opinion of the
 * revision — true as soon as the container answered a startup probe on $PORT
 * once. An app can clear that and refuse every real request afterwards, which is
 * exactly what `epvmx` does with Django's DisallowedHost, and it drew the same
 * green LIVE as a working app.
 *
 * The asking itself now lives in lib/probe-run.ts, because the dashboard asks
 * about every app at once through /api/probes and the two entry points must
 * share one cache — otherwise the batch would wake apps this route had just
 * woken. This stays for the single-app case and for anything holding the URL.
 */
export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  // Checked before anything is read, cache included: a cache hit must not become
  // a way to read another account's app.
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ error: "forbidden" }, { status: 403 });

  return Response.json(await probeApp(slug, uid));
}
