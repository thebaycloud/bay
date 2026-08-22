export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getPool } from "@/lib/db";
import { currentUserId } from "@/lib/session";
import { connectionsForWorkspace, workspaceOwnsInstallation } from "@/lib/github-connections";
import { listRepos } from "@/lib/github-repos";
import { reposResponse, INSTALL_URL, CONFIGURE_URL } from "@/lib/github-import";

/**
 * The import screen's data. Thin on purpose — the decision it serves lives in
 * lib/github-import.ts, where it can be read without a request around it.
 */
export async function GET(req: Request): Promise<Response> {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "not signed in" }, { status: 401 });

  const workspaceId = (await getPool("supersonic_platform").query(
    `SELECT workspace_id FROM users WHERE id = $1`, [userId],
  )).rows[0]?.workspace_id ?? null;
  // A person with no workspace has no connections and cannot have any. The
  // screen still needs somewhere to send them, so the links ship anyway.
  if (!workspaceId) {
    return Response.json({ connections: [], installUrl: INSTALL_URL, configureUrl: CONFIGURE_URL });
  }

  const raw = (new URL(req.url).searchParams.get("installation_id") ?? "").trim();
  const installationId = /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;

  const { status, body } = await reposResponse({
    workspaceId,
    installationId,
    connections: connectionsForWorkspace,
    owns: workspaceOwnsInstallation,
    repos: listRepos,
  });
  return Response.json(body, { status });
}
