export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { listBucketObjects, bucketForSlug } from "@/lib/gcloud";
import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ error: "forbidden", objects: [] }, { status: 403 });
  const bucket = bucketForSlug(slug);
  try {
    return Response.json({ bucket, objects: await listBucketObjects(bucket) });
  } catch (e) {
    return Response.json({ bucket, objects: [], error: e instanceof Error ? e.message : String(e) });
  }
}
