import { installationToken, GithubError } from "./github-app";

/**
 * What an installation can see, and the one function that puts a token in a
 * string.
 *
 * Those two things live together because the second is dangerous and small, and
 * burying it in a module nobody reads is how it ends up called from somewhere
 * that logs its return value. `authenticatedCloneUrl` returns a credential.
 * Every caller of it should be visible from one grep.
 */

const API = "https://api.github.com";
const PER_PAGE = 100;

export interface Repo {
  /**
   * GitHub's id for the repository, and what a push is matched on.
   *
   * The name is what a person picks from and the id is what survives them
   * renaming it afterwards, so the picker carries both: `app_repos.repo_id` is
   * written from here, and a connection that outlives a rename is the reason
   * the column exists at all.
   */
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string | null;
}

export interface ReposDeps {
  fetch: typeof globalThis.fetch;
  token: (installationId: number) => Promise<string>;
}

const live: ReposDeps = {
  fetch: (...a) => globalThis.fetch(...a),
  token: (id) => installationToken(id),
};

/**
 * Every repository the installation was given, across every page.
 *
 * Paginated to exhaustion rather than capped. A cap would silently be the
 * answer to "why can't I see my repository" for exactly the accounts with the
 * most repositories, and a silent cap is indistinguishable from a complete list
 * at the call site.
 */
export async function listRepos(installationId: number, deps: ReposDeps = live): Promise<Repo[]> {
  const token = await deps.token(installationId);
  const out: Repo[] = [];
  for (let page = 1; ; page++) {
    const res = await deps.fetch(`${API}/installation/repositories?per_page=${PER_PAGE}&page=${page}`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "supersonic",
      },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new GithubError({
        kind: res.status === 404 ? "no-installation" : res.status === 401 || res.status === 403 ? "bad-credentials" : "unavailable",
        status: res.status,
        message: body.message || `GitHub answered ${res.status} listing repositories`,
      });
    }
    const body = (await res.json()) as { repositories?: Array<Record<string, unknown>> };
    const batch = body.repositories ?? [];
    for (const r of batch) {
      out.push({
        id: Number(r.id),
        fullName: String(r.full_name),
        private: Boolean(r.private),
        defaultBranch: String(r.default_branch ?? "main"),
        pushedAt: r.pushed_at == null ? null : String(r.pushed_at),
      });
    }
    if (batch.length < PER_PAGE) return sortByRecency(out);
  }
}

/**
 * Most recently pushed first.
 *
 * GitHub returns an installation's repositories in its own order, which is
 * neither alphabetical nor chronological and reads as random to the person
 * scrolling. The repository somebody came here to deploy is, overwhelmingly,
 * the one they pushed to today — so that one is at the top and the picker is
 * usually one click with no scrolling at all.
 *
 * A null `pushed_at` (an empty repository, freshly created) sorts last rather
 * than first: it has nothing to build.
 */
function sortByRecency(repos: Repo[]): Repo[] {
  return repos.sort((a, b) => {
    const at = a.pushedAt ? Date.parse(a.pushedAt) : 0;
    const bt = b.pushedAt ? Date.parse(b.pushedAt) : 0;
    return bt - at;
  });
}

/**
 * GitHub's documented form for cloning with an installation token.
 *
 * THE RETURN VALUE IS A CREDENTIAL. It goes to `git` and nowhere else — not to
 * a log line, not into `apps.repo_url`, not back to a browser.
 *
 * Any existing userinfo is replaced rather than kept, because a stored URL that
 * once carried a token would otherwise produce two sets of credentials and a
 * host git cannot resolve. The match is anchored to the authority — `[^@/]*@`
 * cannot reach past the first slash — so a path containing an `@` is left
 * alone rather than read as credentials.
 */
export function authenticatedCloneUrl(repoUrl: string, token: string): string {
  const url = repoUrl.trim();
  if (!/^https?:\/\//i.test(url)) return url;
  return url.replace(/^(https?:\/\/)(?:[^@/]*@)?/i, `$1x-access-token:${token}@`);
}

/** Mint for this installation and hand back a URL `git clone` can use. */
export async function cloneUrlFor(installationId: number, repoUrl: string, deps: ReposDeps = live): Promise<string> {
  return authenticatedCloneUrl(repoUrl, await deps.token(installationId));
}

/**
 * `owner/repo` out of whatever form the repository URL arrived in.
 *
 * Empty string when it is not a GitHub URL at all, which is a real case rather
 * than an error: the URL door still accepts GitLab, a self-hosted git, and a
 * `file://` path, and none of those can be connected to a push.
 *
 * The `.git` suffix and a trailing slash are both stripped because both are
 * things people paste, and `owner/repo.git` is not a name any GitHub API path
 * accepts.
 */
export function fullNameFromUrl(url: string): string {
  const m = /^(?:https?:\/\/)?(?:[^@/]*@)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : "";
}

/**
 * One repository, as this installation sees it.
 *
 * Exists so a connection is never written from a name and an id the CLIENT
 * supplied. The picker knows both, and posting them would be faster — but an
 * installation id in a request body is already only a claim (see
 * lib/github-connections.ts), and a repository id beside it would be a second
 * one, checked by nothing, written into the column that decides which pushes
 * ship. Asking GitHub costs one request at connect time and makes the id a fact.
 *
 * Null when this installation cannot see the repository, which covers both "it
 * does not exist" and "you were not given it" — GitHub answers 404 to each, on
 * purpose, and the person's next step is the same for both: widen the
 * installation's selection.
 */
export async function repoFor(installationId: number, fullName: string, deps: ReposDeps = live): Promise<Repo | null> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) return null;
  const token = await deps.token(installationId);
  const res = await deps.fetch(`${API}/repos/${fullName}`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "supersonic",
    },
  });
  if (!res.ok) return null;
  const r = (await res.json()) as Record<string, unknown>;
  return {
    id: Number(r.id),
    fullName: String(r.full_name),
    private: Boolean(r.private),
    defaultBranch: String(r.default_branch ?? "main"),
    pushedAt: r.pushed_at == null ? null : String(r.pushed_at),
  };
}
