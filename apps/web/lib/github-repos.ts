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
        fullName: String(r.full_name),
        private: Boolean(r.private),
        defaultBranch: String(r.default_branch ?? "main"),
        pushedAt: r.pushed_at == null ? null : String(r.pushed_at),
      });
    }
    if (batch.length < PER_PAGE) return out;
  }
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
