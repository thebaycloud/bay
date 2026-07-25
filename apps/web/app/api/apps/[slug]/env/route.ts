export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { describeService, setEnv, ownsApp } from "@/lib/gcloud";
import { currentUserId } from "@/lib/session";

// GET  -> list env var KEYS (values are never exposed)
export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ keys: [], error: "forbidden" }, { status: 403 });
  try {
    const svc = await describeService(slug);
    return Response.json({ keys: svc.envKeys });
  } catch (e) {
    return Response.json({ keys: [], error: e instanceof Error ? e.message : String(e) });
  }
}

// POST { set?: {K:V}, unset?: [K] } -> update env, new revision
export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ error: "forbidden" }, { status: 403 });
  const { set = {}, unset = [] } = await req.json().catch(() => ({}));
  try {
    await setEnv(slug, set as Record<string, string>, unset as string[]);
    const svc = await describeService(slug);
    return Response.json({ ok: true, keys: svc.envKeys });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
