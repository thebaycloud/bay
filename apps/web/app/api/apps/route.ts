export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { listServices } from "@/lib/gcloud";
import { currentUserId } from "@/lib/session";

export async function GET() {
  const uid = await currentUserId();
  if (!uid) return Response.json({ apps: [], error: "not signed in" }, { status: 401 });
  try {
    return Response.json({ apps: await listServices(uid) });
  } catch (e) {
    return Response.json({ apps: [], error: e instanceof Error ? e.message : String(e) });
  }
}
