export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getAppBySlug } from "@/lib/apps";
import { currentUserId } from "@/lib/session";
import { repoForSlug, setBranch, setAutoDeploy, unlinkRepo } from "@/lib/app-repos";

/**
 * One app's connected repository: read it, change which branch it follows,
 * turn automatic shipping off, or disconnect it.
 *
 * Owner-only, asked of the app row, following
 * `app/api/apps/[slug]/domains/route.ts`. The installation was already checked
 * against the workspace when the link was written; what this route guards is
 * narrower and simpler — only the app's owner may change what its own app
 * follows.
 */
async function ownedApp(slug: string) {
  const uid = await currentUserId();
  if (!uid) return null;
  const app = await getAppBySlug(slug);
  if (!app || app.owner_id !== uid) return null;
  return app;
}

/**
 * What the panel draws, and nothing else.
 *
 * `installationId` is deliberately absent. It is ours, it means nothing to the
 * person, and a field a page does not use is a field that leaks the day
 * somebody logs the payload — the same rule the domains route states about
 * `cert_id`.
 */
export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  if (!(await ownedApp(slug))) return Response.json({ error: "not found" }, { status: 404 });
  const link = await repoForSlug(slug);
  // `connected: false` rather than a 404: "this app has no repository" is a
  // normal state with its own screen, not a missing resource.
  if (!link) return Response.json({ connected: false });
  return Response.json({
    connected: true,
    repo: link.repoFullName,
    branch: link.branch,
    autoDeploy: link.autoDeploy,
    connectedAt: link.connectedAt,
    url: `https://github.com/${link.repoFullName}`,
  });
}

/**
 * Change the branch, the switch, or both.
 *
 * A branch is not validated against GitHub here. It could be — one request —
 * and it would refuse a branch that does not exist YET, which is a normal thing
 * to set up before pushing it. A branch nobody pushes is a connection that
 * simply never fires, and that is visible in the app's timeline; a refusal
 * would be a wrong answer that costs a person their afternoon.
 */
export async function PUT(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  if (!(await ownedApp(slug))) return Response.json({ error: "not found" }, { status: 404 });
  if (!(await repoForSlug(slug))) return Response.json({ error: "no repository is connected" }, { status: 409 });

  const body = (await req.json().catch(() => ({}))) as { branch?: unknown; autoDeploy?: unknown };

  if (typeof body.branch === "string") {
    const branch = body.branch.trim();
    // Git's own rules, reduced to what a branch name can never contain. A name
    // that git would refuse must not reach the column a push is matched on,
    // where it would simply never match and look like a broken integration.
    if (!branch || branch.length > 255 || /[\s~^:?*\[\\]/.test(branch) || branch.includes("..")) {
      return Response.json({ error: "that is not a branch name" }, { status: 400 });
    }
    await setBranch(slug, branch);
  }

  if (typeof body.autoDeploy === "boolean") await setAutoDeploy(slug, body.autoDeploy);

  const link = await repoForSlug(slug);
  return Response.json({ connected: true, repo: link?.repoFullName, branch: link?.branch, autoDeploy: link?.autoDeploy });
}

/**
 * Disconnect. The app keeps running and keeps its `repo_url`, so it can still
 * be rebuilt from the same repository by hand — what stops is the automatic
 * part, which is the only thing this row ever controlled.
 */
export async function DELETE(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  if (!(await ownedApp(slug))) return Response.json({ error: "not found" }, { status: 404 });
  await unlinkRepo(slug);
  return Response.json({ connected: false });
}
