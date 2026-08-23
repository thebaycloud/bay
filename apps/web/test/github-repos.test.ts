import { test } from "node:test";
import assert from "node:assert/strict";
import { listRepos, authenticatedCloneUrl, cloneUrlFor, type ReposDeps } from "../lib/github-repos";

/**
 * What an installation can see, and the single place a token is spliced into a
 * string.
 *
 * `authenticatedCloneUrl` is a line of logic and it is tested harder than
 * anything else here, because it is the function whose output must never be
 * logged, stored, or returned to a browser. Everything about keeping the token
 * out of those places depends on it being obvious which value is the dangerous
 * one.
 */

function deps(pages: unknown[][], token = "ghs_tok"): ReposDeps & { calls: string[] } {
  const calls: string[] = [];
  let page = 0;
  return {
    calls,
    token: async () => token,
    fetch: (async (url: string) => {
      calls.push(String(url));
      const repos = pages[page++] ?? [];
      return new Response(JSON.stringify({ total_count: 0, repositories: repos }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch,
  };
}

test("repositories come back with the fields the picker renders", async () => {
  const d = deps([[{
    id: 1030493218, full_name: "thebaycloud/bay", private: true,
    default_branch: "main", pushed_at: "2026-08-22T10:00:00Z",
  }]]);
  const repos = await listRepos(155650459, d);
  // The id rides along because a push is matched on it, not on the name — which
  // is what makes a connection survive somebody renaming their repository.
  assert.deepEqual(repos, [{
    id: 1030493218, fullName: "thebaycloud/bay", private: true,
    defaultBranch: "main", pushedAt: "2026-08-22T10:00:00Z",
  }]);
});

test("every page is fetched, not just the first", async () => {
  // An installation with 130 repositories returns 100 then 30. Stopping at the
  // first page is the bug that produces "I can't see my repository" for exactly
  // the accounts that have the most of them.
  const d = deps([
    Array.from({ length: 100 }, (_, i) => ({ id: i + 1, full_name: `o/r${i}`, private: true, default_branch: "main", pushed_at: null })),
    Array.from({ length: 30 }, (_, i) => ({ id: 1000 + i, full_name: `o/s${i}`, private: true, default_branch: "main", pushed_at: null })),
  ]);
  const repos = await listRepos(1, d);
  assert.equal(repos.length, 130);
  assert.match(d.calls[0], /per_page=100&page=1/);
  assert.match(d.calls[1], /per_page=100&page=2/);
});

test("a short page ends the walk", async () => {
  const d = deps([[{ full_name: "o/r", private: false, default_branch: "main", pushed_at: null }]]);
  await listRepos(1, d);
  assert.equal(d.calls.length, 1, "asked for a page after a short one");
});

test("the token goes in as x-access-token and the path is untouched", () => {
  assert.equal(
    authenticatedCloneUrl("https://github.com/thebaycloud/bay.git", "ghs_abc"),
    "https://x-access-token:ghs_abc@github.com/thebaycloud/bay.git",
  );
});

test("a url that already carries credentials has them replaced, not appended", () => {
  // Otherwise a redeploy of an app stored with an old token produces
  // https://x-access-token:new@x-access-token:old@github.com/... which git
  // parses as a host that does not exist.
  assert.equal(
    authenticatedCloneUrl("https://x-access-token:old@github.com/o/r.git", "new"),
    "https://x-access-token:new@github.com/o/r.git",
  );
});

test("a non-https url is returned untouched rather than mangled", () => {
  // An ssh remote reaches this only through a bug, and a token in it would be
  // nonsense. Failing to clone is better than cloning something unexpected.
  assert.equal(authenticatedCloneUrl("git@github.com:o/r.git", "t"), "git@github.com:o/r.git");
});

test("the host is not swapped by a url that looks like it has userinfo", () => {
  // A path containing @ must not be read as credentials — the replacement is
  // anchored to the authority, not to the first @ in the string.
  assert.equal(
    authenticatedCloneUrl("https://github.com/o/we@ird.git", "t"),
    "https://x-access-token:t@github.com/o/we@ird.git",
  );
});

test("cloneUrlFor mints and splices in one step", async () => {
  const d = deps([], "ghs_minted");
  assert.equal(
    await cloneUrlFor(155650459, "https://github.com/o/r.git", d),
    "https://x-access-token:ghs_minted@github.com/o/r.git",
  );
});

test("a refusal while listing is a GithubError with the kind, not a raw status", async () => {
  const { GithubError } = await import("../lib/github-app");
  const d: ReposDeps = {
    token: async () => "t",
    fetch: (async () => new Response(JSON.stringify({ message: "Not Found" }), {
      status: 404, headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch,
  };
  const e = await listRepos(1, d).then(() => null, (x) => x);
  assert.ok(e instanceof GithubError);
  assert.equal(e.refusal.kind, "no-installation");
});

test("the picker gets the most recently pushed repository first", async () => {
  // GitHub's own order is neither alphabetical nor chronological, and the
  // repository somebody came to deploy is almost always the one they pushed to
  // today. An empty repository — no `pushed_at` — has nothing to build and goes
  // last rather than first, which is where a plain date sort would put it.
  const d = deps([[
    { id: 1, full_name: "o/old", private: false, default_branch: "main", pushed_at: "2024-01-01T00:00:00Z" },
    { id: 2, full_name: "o/empty", private: false, default_branch: "main", pushed_at: null },
    { id: 3, full_name: "o/today", private: false, default_branch: "main", pushed_at: "2026-08-23T18:45:00Z" },
  ]]);
  const repos = await listRepos(1, d);
  assert.deepEqual(repos.map((r) => r.fullName), ["o/today", "o/old", "o/empty"]);
});

test("the order holds across pages, not only within one", async () => {
  // The sort runs once on the whole list. Sorting per page would leave page
  // two's fresher repository below page one's stale ones — the exact failure a
  // person with a hundred repositories would hit and nobody testing with five
  // would see.
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1, full_name: `o/r${i}`, private: false, default_branch: "main",
    pushed_at: "2024-01-01T00:00:00Z",
  }));
  const d = deps([page1, [
    { id: 999, full_name: "o/fresh", private: false, default_branch: "main", pushed_at: "2026-08-23T00:00:00Z" },
  ]]);
  const repos = await listRepos(1, d);
  assert.equal(repos.length, 101);
  assert.equal(repos[0].fullName, "o/fresh");
});
