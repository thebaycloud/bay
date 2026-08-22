import { appJwt, GithubError } from "./github-app";

/**
 * What the install callback decides, and who the installation belongs to.
 *
 * Lives here rather than in the route because a Next route file may export
 * nothing but its handlers, and the only interesting thing in that route is a
 * decision worth testing without a request around it.
 */

export type CallbackDecision =
  | { ok: true; installationId: number }
  | { ok: false; reason: "no-installation" };

/**
 * The installation id from GitHub's redirect, or a refusal.
 *
 * Matched as digits before it is turned into a number, not after. `Number("")`
 * is 0, `Number("abc")` is NaN and `Number("1e9")` is a million times what was
 * written — every one of those is a value that looks like an id to the next
 * line and is not one. The safe-integer bound matters too: a bigint beyond
 * 2^53 silently changes value on the way through.
 */
export function installationFromCallback(url: URL): CallbackDecision {
  const raw = (url.searchParams.get("installation_id") ?? "").trim();
  if (!/^\d+$/.test(raw)) return { ok: false, reason: "no-installation" };
  const installationId = Number(raw);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return { ok: false, reason: "no-installation" };
  }
  return { ok: true, installationId };
}

export interface Account { login: string; type: string }

/**
 * Who the installation belongs to, for the label the import screen shows.
 *
 * Asked once, at connect time, and stored — the alternative is a network round
 * trip every time a list of connected accounts is drawn.
 */
export async function accountFor(
  installationId: number,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<Account> {
  const res = await fetchFn(`https://api.github.com/app/installations/${installationId}`, {
    headers: {
      Authorization: `Bearer ${appJwt()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "supersonic",
    },
  });
  if (!res.ok) {
    throw new GithubError({
      kind: res.status === 401 || res.status === 403 ? "bad-credentials" : "no-installation",
      status: res.status,
      message: `could not read installation ${installationId}`,
    });
  }
  const body = (await res.json()) as { account?: { login?: string; type?: string } };
  return {
    login: String(body.account?.login ?? "your account"),
    type: String(body.account?.type ?? "Organization"),
  };
}
