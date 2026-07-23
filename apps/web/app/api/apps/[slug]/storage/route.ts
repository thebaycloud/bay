export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { listBucketObjects, bucketForSlug } from "@/lib/gcloud";

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const bucket = bucketForSlug(decodeURIComponent(params.slug));
  try {
    return Response.json({ bucket, objects: await listBucketObjects(bucket) });
  } catch (e) {
    return Response.json({ bucket, objects: [], error: e instanceof Error ? e.message : String(e) });
  }
}
