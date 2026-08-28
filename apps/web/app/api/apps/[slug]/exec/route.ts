export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { forbiddenBody } from "@/lib/api-error";
import { execCommand } from "@/lib/gcloud";
import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";
import { deployTargetForApp } from "@/lib/deploy-target";

// Run a command in a one-off container built from the app's image (isolated
// from the serving instances, but with the app's env + Cloud SQL attached).
export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json(forbiddenBody(), { status: 403 });
  const { command } = await req.json().catch(() => ({}));
  if (!command || typeof command !== "string") return Response.json({ error: "no command provided" }, { status: 400 });
  // `execCommand` deploys a one-off Cloud Run job from the app's image. For an
  // app on a node that is either impossible — no service, no job — or worse:
  // a migrated app still has the Cloud Run side, so this would run the command
  // in a container that shares the image and NOT the machine, the data directory
  // or the network the app actually lives on. An exec that lies about where it
  // ran is worse than no exec.
  const target = await deployTargetForApp(slug);
  if (!target.supports("exec")) {
    return Response.json(
      { error: "this app runs on a node, where exec is not wired up yet — it needs to enter the running sandbox, not a copy of its image." },
      { status: 501 },
    );
  }
  try {
    const { output, exitCode } = await execCommand(slug, command);
    return Response.json({ output, exitCode });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
