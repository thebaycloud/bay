export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { listJobs, createJob, deleteJob, runJob, describeService } from "@/lib/gcloud";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  try { return Response.json({ jobs: await listJobs(slug) }); }
  catch (e) { return Response.json({ jobs: [], error: msg(e) }); }
}

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const body = await req.json().catch(() => ({}));
  try {
    if (body.run) { await runJob(String(body.run)); return Response.json({ ok: true }); }
    const name = String(body.name || "job");
    const schedule = String(body.schedule || "");
    const path = String(body.path || "/");
    if (!schedule) return Response.json({ error: "schedule (cron) required" }, { status: 400 });
    const svc = await describeService(slug);
    if (!svc.url) return Response.json({ error: "app has no URL yet" }, { status: 400 });
    const uri = svc.url.replace(/\/$/, "") + (path.startsWith("/") ? path : "/" + path);
    const id = await createJob(slug, name, schedule, uri);
    return Response.json({ ok: true, id });
  } catch (e) { return Response.json({ error: msg(e) }); }
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  try { await deleteJob(id); return Response.json({ ok: true }); }
  catch (e) { return Response.json({ error: msg(e) }); }
}
