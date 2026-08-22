import { GithubError } from "./github-app";
import type { Connection } from "./github-connections";
import type { Repo } from "./github-repos";

/**
 * What the import screen draws: which accounts are connected, and what is in
 * one of them.
 *
 * Vercel ships a knowledge-base page for "I can't see my repository" and the
 * answer is always that the App was installed against a narrower selection than
 * the person thinks. So the configure link ships with the LIST, every time,
 * whether or not anything looks wrong — it is not an error state, it is the
 * second half of the answer to a question the list itself provokes.
 */

/** Where a person goes to connect an account for the first time. */
export const INSTALL_URL = "https://github.com/apps/the-bay-cloud/installations/new";
/** Where a person goes to change which repositories we can see. */
export const CONFIGURE_URL = "https://github.com/apps/the-bay-cloud/installations/select_target";

export interface ImportDeps {
  workspaceId: string;
  installationId: number | null;
  connections: (workspaceId: string) => Promise<Connection[]>;
  owns: (workspaceId: string, installationId: number) => Promise<boolean>;
  repos: (installationId: number) => Promise<Repo[]>;
}

/**
 * The decision, without a request around it.
 *
 * The only branch here that has to be right is the 403, and reaching it through
 * a Request would mean standing up a session and a pool to assert one line.
 */
export async function reposResponse(d: ImportDeps): Promise<{ status: number; body: unknown }> {
  if (d.installationId === null) {
    const list = await d.connections(d.workspaceId);
    return {
      status: 200,
      body: {
        connections: list.map((c) => ({ installationId: c.installationId, accountLogin: c.accountLogin })),
        installUrl: INSTALL_URL,
        configureUrl: CONFIGURE_URL,
      },
    };
  }
  // Before anything is minted. An installation id in a query string is a claim,
  // and the whole of this phase's security is that we check it against the
  // caller's workspace instead of believing it.
  if (!(await d.owns(d.workspaceId, d.installationId))) {
    return { status: 403, body: { error: "that account is not connected to your workspace" } };
  }
  try {
    return { status: 200, body: { repos: await d.repos(d.installationId) } };
  } catch (e) {
    // Only GitHub's refusals become a connection problem. A TypeError of ours
    // rendering as "reconnect your account" would send a person to spend an
    // afternoon on a link that was never the problem.
    if (e instanceof GithubError) {
      return {
        status: 409,
        body: { reason: e.refusal.kind, configureUrl: CONFIGURE_URL, installUrl: INSTALL_URL },
      };
    }
    throw e;
  }
}
