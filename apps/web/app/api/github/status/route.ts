export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { currentUserId } from "@/lib/session";
import { getPool } from "@/lib/db";
import { connectionsForWorkspace } from "@/lib/github-connections";
import { listRepos } from "@/lib/github-repos";
import { CONFIGURE_URL, INSTALL_URL, manageUrl } from "@/lib/github-import";
import { memo } from "@/lib/memo";

/**
 * What this workspace has connected on GitHub, and how much of it we can see.
 *
 * Exists because the only answer the product gave before was inside the Ship-new
 * dialog, and only while somebody was in the middle of shipping. "Is GitHub
 * connected, to which account, and can it see the repository I care about" is a
 * question people ask when they are NOT shipping — which is what a settings page
 * is for.
 *
 * The repository COUNT is the fact worth the extra call. Every "why can't I see
 * my repo" is the App's repository selection, and a count is the cheapest thing
 * that makes that visible: 47 says the selection is broad, 1 says it is not.
 *
 * `null`, never 0, when the listing failed. Zero is a real answer — an
 * installation with nothing shared — and a failed read that reports it would
 * send somebody to reconfigure a selection that was fine.
 */
export async function GET(): Promise<Response> {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "not signed in" }, { status: 401 });

  const workspaceId = (await getPool("supersonic_platform").query(
    `SELECT workspace_id FROM users WHERE id = $1`,
    [userId],
  )).rows[0]?.workspace_id ?? null;

  if (!workspaceId) {
    return Response.json({ connections: [], installUrl: INSTALL_URL, configureUrl: CONFIGURE_URL });
  }

  const list = await connectionsForWorkspace(workspaceId);
  const connections = await Promise.all(
    list.map(async (c) => {
      // Memoised for a minute, and keyed on the installation: settings and the
      // Ship-new dialog ask the same question, and a person moving between them
      // should not pay for the same listing twice.
      const repoCount = await memo(`gh:repos:${c.installationId}`, 60_000, () =>
        listRepos(c.installationId).then((r) => r.length),
      ).catch(() => null);
      return {
        installationId: c.installationId,
        accountLogin: c.accountLogin,
        accountType: c.accountType,
        // Null for an organisation, permanently: GitHub does not say which
        // member installed it. See lib/github-connections.
        connectedLogin: c.connectedLogin ?? null,
        repoCount,
        manageUrl: manageUrl(c.accountLogin, c.accountType),
      };
    }),
  );

  return Response.json({ connections, installUrl: INSTALL_URL, configureUrl: CONFIGURE_URL });
}
