export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { listJobs, createJob, deleteJob, runJob, describeService } from "@/lib/gcloud";
import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";
import { withCors, optionsHandler } from "@/lib/cors";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function getHandler(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ jobs: [], error: "forbidden" }, { status: 403 });
  try { return Response.json({ jobs: await listJobs(slug) }); }
  catch (e) { return Response.json({ jobs: [], error: msg(e) }); }
}

async function postHandler(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  try {
    if (body.run) { await runJob(String(body.run)); return Response.json({ ok: true }); }
    const name = String(body.name || "job");
    const schedule = String(body.schedule || "");
    const path = String(body.path || "/");
    if (!schedule) return Response.json({ error: "schedule (cron) required" }, { status: 400 });
    const svc = await describeService(slug);
    if (!svc.url) return Response.json({ error: "app has no URL yet" }, { status: 400 });
    const id = await createJob(slug, name, schedule, svc.url, path);
    return Response.json({ ok: true, id });
  } catch (e) { return Response.json({ error: msg(e) }); }
}

async function deleteHandler(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ error: "forbidden" }, { status: 403 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  try { await deleteJob(id); return Response.json({ ok: true }); }
  catch (e) { return Response.json({ error: msg(e) }); }
}


// Reachable from the app's own X-ray drawer, which runs on the app's own
// origin. See lib/cors.ts: only THAT origin is allowed, never every subdomain.
export const OPTIONS = optionsHandler;
export const GET = withCors(getHandler);
export const POST = withCors(postHandler);
export const DELETE = withCors(deleteHandler);
