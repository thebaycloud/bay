export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getPool } from "@/lib/db";
import { currentUserId } from "@/lib/session";
import { installationToken, GithubError } from "@/lib/github-app";
import { recordInstallation } from "@/lib/github-connections";
import { installationFromCallback, accountFor } from "@/lib/github-setup";

/**
 * Where GitHub sends a person after they install the App.
 *
 * This is the one moment the platform learns an installation id without a
 * caller it has to distrust telling it one, which is why the connection is
 * written here and nowhere else. The id arrives in a query string the person's
 * own browser followed, alongside their session cookie — so "who is connecting"
 * comes from the session, never from the URL.
 *
 * It is not a security boundary on its own: anyone can hit this route with any
 * number. Two things make that harmless. The id is checked against GitHub
 * before it is stored — we mint a token for it, which only succeeds for an
 * installation of OUR App — and the workspace recorded is the caller's own. So
 * the worst a person can do is claim an installation they already knew the id
 * of, which is one they could already see. Phase two's `installation` webhook
 * carries the account independently and is where that gets tightened.
 */

function back(req: Request, params: Record<string, string>): Response {
  const to = new URL("/new", new URL(req.url).origin);
  for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
  return Response.redirect(to.toString(), 302);
}

export async function GET(req: Request): Promise<Response> {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "not signed in" }, { status: 401 });

  const decision = installationFromCallback(new URL(req.url));
  if (!decision.ok) return back(req, { github_error: decision.reason });

  const workspaceId = (await getPool("supersonic_platform").query(
    `SELECT workspace_id FROM users WHERE id = $1`, [userId],
  )).rows[0]?.workspace_id ?? null;
  if (!workspaceId) return back(req, { github_error: "no-workspace" });

  try {
    // Minting proves the installation is real, is ours, and is reachable —
    // before a row claims all three. The token itself is discarded; it will be
    // minted again, from cache, the moment anything needs it.
    await installationToken(decision.installationId);
    const account = await accountFor(decision.installationId);
    await recordInstallation({
      installationId: decision.installationId,
      workspaceId,
      accountLogin: account.login,
      accountType: account.type,
      connectedBy: userId,
    });
    return back(req, { connected: account.login });
  } catch (e) {
    // Never GitHub's message in a URL: it is text we did not write, landing on
    // a page we render. The KIND is ours, and is all the screen needs to say
    // the right sentence.
    const kind = e instanceof GithubError ? e.refusal.kind : "unavailable";
    return back(req, { github_error: kind });
  }
}
