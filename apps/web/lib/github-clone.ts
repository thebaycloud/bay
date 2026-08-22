import { installationToken } from "./github-app";
import { workspaceOwnsInstallation } from "./github-connections";

/**
 * Whether this caller may clone through this installation, and the token if so.
 *
 * One function, two callers. `/api/detect` turns the result into a URL and the
 * deploy pipeline hands it to `fetchSource`, but the question in front of both
 * is identical — and a check written twice is a check that disagrees with
 * itself eventually.
 *
 * It cannot live in a route. `runDeploy` is reached three ways — the request
 * handler, the deploy worker and the deploy job — so a check at the top of one
 * of them is a check the other two never make.
 */

export interface CloneAuthDeps {
  workspaceId: string | null;
  installationId: number | null;
  owns: (workspaceId: string, installationId: number) => Promise<boolean>;
  mint: (installationId: number) => Promise<string>;
}

const live = {
  owns: workspaceOwnsInstallation,
  mint: (id: number) => installationToken(id),
};

/**
 * `undefined` when no installation is named — a public URL or an upload, and
 * the clone is exactly what it has always been.
 *
 * Throws when one IS named and this workspace does not own it. Refusing after
 * minting would already have handed a credential to code that was not allowed
 * one, so the check is before, and a workspace that could not be resolved is a
 * no rather than a skipped question.
 */
export async function cloneTokenFor(
  d: Pick<CloneAuthDeps, "workspaceId" | "installationId"> & Partial<Pick<CloneAuthDeps, "owns" | "mint">>,
): Promise<string | undefined> {
  // `== null`, covering undefined as well. The concept is "no installation was
  // named", and undefined is how that arrives from a jsonb row written before
  // the field existed and from any caller that simply does not set it. A strict
  // === null here turns every one of those into "not connected to your
  // workspace", which is a refusal aimed at a person who named nothing.
  if (d.installationId == null) return undefined;
  const owns = d.owns ?? live.owns;
  const mint = d.mint ?? live.mint;
  if (!d.workspaceId || !(await owns(d.workspaceId, d.installationId))) {
    throw new Error("that account is not connected to your workspace");
  }
  return mint(d.installationId);
}

/**
 * Text from `git`, with the token taken out of it.
 *
 * Today's git already redacts userinfo from its messages — checked, on a failed
 * clone against both a missing repository and an unresolvable host. This does
 * not depend on that. The claim being defended is that the token reaches no log
 * line and no response body, and a claim resting on another program's error
 * formatting is one that breaks on an upgrade nobody connected to it.
 *
 * A no-op when there was no token, which is the common path.
 */
export function redactToken(text: string, token: string | undefined): string {
  if (!token) return text;
  return text.split(token).join("x-access-token");
}
