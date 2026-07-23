export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { listServices } from "@/lib/gcloud";

export async function GET() {
  try {
    return Response.json({ apps: await listServices() });
  } catch (e) {
    return Response.json({ apps: [], error: e instanceof Error ? e.message : String(e) });
  }
}
