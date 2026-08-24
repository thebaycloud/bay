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

/**
 * The app name a person had already typed before they were sent to GitHub.
 *
 * GitHub hands an App's install URL one opaque `state` parameter and gives it
 * back on the setup redirect, which is the only channel there is: the install
 * happens on github.com, in a flow we do not control, and anything we knew
 * before it is otherwise gone by the time they come back. Somebody who names an
 * app, discovers their account is not connected, connects it and then finds the
 * name field empty has been made to do the same work twice.
 *
 * Validated as a slug rather than trusted, because it is a string that left our
 * origin and came back through a third party — it lands in a query string on a
 * page we render, and the set of characters that can be in a Cloud Run name is
 * far smaller than the set that can hurt. Anything else answers empty, which
 * means "name it from the repository", exactly as before.
 */
/**
 * Where to send somebody back to, from the one opaque parameter GitHub returns.
 *
 * The install happens on github.com. Everything we knew before it — which page
 * they were on, what they had typed — is gone by the time they come back, and
 * `state` is the only channel: GitHub hands an App's install URL one string and
 * gives it back on the setup redirect.
 *
 * It used to carry the app name and the redirect was hardcoded to `/new`, so
 * connecting from the Ship-new dialog on the app list dropped somebody onto a
 * different page with the dialog gone — an install that succeeded and looked
 * like nothing had happened.
 *
 * An ALLOW-LIST of two, not a path. This value left our origin and came back
 * through a third party, and a redirect target taken from a string like that is
 * an open redirect — the one bug this function exists to not have.
 */
export function returnPathFromCallback(url: URL): "/" | "/new" {
  return (url.searchParams.get("state") ?? "").trim() === "apps" ? "/" : "/new";
}

export function nameFromCallback(url: URL): string {
  const raw = (url.searchParams.get("state") ?? "").trim();
  return /^[a-z0-9][a-z0-9-]{0,38}$/.test(raw) ? raw : "";
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
