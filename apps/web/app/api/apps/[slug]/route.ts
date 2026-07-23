export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { describeService } from "@/lib/gcloud";

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  try {
    return Response.json(await describeService(decodeURIComponent(params.slug)));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
}
