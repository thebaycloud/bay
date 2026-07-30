export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { execCommand } from "@/lib/gcloud";
import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";

// Run a command in a one-off container built from the app's image (isolated
// from the serving instances, but with the app's env + Cloud SQL attached).
export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ error: "forbidden" }, { status: 403 });
  const { command } = await req.json().catch(() => ({}));
  if (!command || typeof command !== "string") return Response.json({ error: "no command provided" }, { status: 400 });
  try {
    const { output, exitCode } = await execCommand(slug, command);
    return Response.json({ output, exitCode });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
