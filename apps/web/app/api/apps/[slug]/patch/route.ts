export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";
import { readLatestPatch } from "@/lib/deploy-events";

/**
 * The repair agent's fix, as a patch.
 *
 * The agent edits the copy of the repo the deploy unpacked on the server, and
 * that copy is deleted when the deploy ends. So a rescued app used to leave the
 * user's own folder still broken, and their next deploy shipped the same code
 * again — the dashboard saying "fixed" and the repository disagreeing, with
 * nothing to reconcile them.
 *
 * Served as text/plain and nothing else, because the only useful thing to do
 * with it is pipe it into `git apply`. Wrapping it in JSON would mean every
 * caller has to unwrap it before it becomes a patch again.
 */
export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return new Response("forbidden\n", { status: 403 });

  const patch = await readLatestPatch(slug);
  if (!patch) {
    // 404 rather than an empty 200: piping nothing into `git apply` succeeds
    // silently, and "it worked and changed nothing" is the one answer that must
    // not be possible here.
    return new Response("no patch — the last deploy of this app was not fixed by the repair agent\n", { status: 404 });
  }
  return new Response(patch.endsWith("\n") ? patch : patch + "\n", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
