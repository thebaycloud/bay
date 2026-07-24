export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getErrors, ownsApp } from "@/lib/gcloud";
import { currentUserId } from "@/lib/session";

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ errors: [], error: "forbidden" }, { status: 403 });
  return Response.json({ errors: await getErrors(slug) });
}
