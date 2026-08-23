import { installationToken } from "./github-app";

/**
 * Say on the commit what happened to it.
 *
 * A commit status rather than a Check Run. It is one API call, it renders in
 * the same place — on the commit, and in any pull request the commit is in —
 * and a Check Run would buy us a log-rendering surface we would then have to
 * fill, when the log already has a home at the app's own address.
 *
 * ## Best-effort, by contract
 *
 * Every function here resolves. None of them throws, for any reason, including
 * a GitHub that is down or a token that cannot be minted. Two callers depend on
 * that: the dispatcher, where a failed status write must not stop a build that
 * a person is waiting for, and the `finally` in lib/deploy-one.ts, where a
 * throw would replace the deploy's real outcome with an error about GitHub.
 *
 * A deploy that worked being reported as failed because a status could not be
 * written is strictly worse than no status at all.
 */

const API = "https://api.github.com";

export type StatusState = "pending" | "success" | "failure" | "error";

export interface StatusDeps {
  fetch: typeof globalThis.fetch;
  token: (installationId: number) => Promise<string>;
}

const live: StatusDeps = {
  fetch: (...a) => globalThis.fetch(...a),
  token: (id) => installationToken(id),
};

/**
 * The name GitHub groups statuses under.
 *
 * Per-app rather than a constant, so every build of one app REPLACES that app's
 * previous status rather than stacking a new one beside it — and so a monorepo
 * with two connected apps can report two independent outcomes on the same
 * commit without either overwriting the other.
 */
export function contextFor(slug: string): string {
  return `supersonic/${slug}`;
}

export interface StatusPost {
  installationId: number;
  fullName: string;
  sha: string;
  state: StatusState;
  slug: string;
  targetUrl?: string;
  description?: string;
}

/**
 * Returns whether GitHub accepted it, for a caller that wants to log the
 * difference. Nobody is required to look.
 */
export async function postCommitStatus(o: StatusPost, deps: StatusDeps = live): Promise<boolean> {
  if (!o.fullName || !/^[0-9a-f]{40}$/i.test(o.sha)) return false;
  try {
    const token = await deps.token(o.installationId);
    const res = await deps.fetch(`${API}/repos/${o.fullName}/statuses/${o.sha}`, {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "supersonic",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state: o.state,
        target_url: o.targetUrl,
        // GitHub truncates past 140 characters. Doing it here keeps the
        // sentence ours to end rather than GitHub's to cut mid-word.
        description: (o.description ?? "").slice(0, 140),
        context: contextFor(o.slug),
      }),
    });
    if (!res.ok) {
      // 403 here is the one worth recognising on sight: it means the App holds
      // no `statuses: write`, which is a permission a human grants once and
      // nothing in this process can repair.
      console.error(`github: status ${o.state} on ${o.fullName}@${o.sha.slice(0, 7)} refused (${res.status})`);
    }
    return res.ok;
  } catch (e) {
    console.error("github: could not post a commit status —", e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * Where a branch points right now.
 *
 * Asked at dispatch so the FIRST build of a newly connected repository is
 * pinned to a commit, exactly as every push-triggered one is. Without it the
 * first build would be of "whatever HEAD is when the builder starts" and would
 * have no SHA to report an outcome against — so the first build of an app, the
 * one its owner is watching hardest, would be the only build that never gets a
 * tick in GitHub.
 *
 * Returns null rather than throwing: the caller falls back to an unpinned
 * clone, which is exactly what every deploy did before this existed.
 */
export async function branchHead(
  installationId: number,
  fullName: string,
  branch: string,
  deps: StatusDeps = live,
): Promise<string | null> {
  if (!fullName || !branch) return null;
  try {
    const token = await deps.token(installationId);
    const res = await deps.fetch(`${API}/repos/${fullName}/commits/${encodeURIComponent(branch)}`, {
      headers: {
        Authorization: `token ${token}`,
        // The SHA is all that is wanted, and this media type is how GitHub is
        // asked for just it. The alternative is parsing one field out of a
        // commit object that carries the whole diff stat.
        Accept: "application/vnd.github.sha",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "supersonic",
      },
    });
    if (!res.ok) return null;
    const sha = (await res.text()).trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}
