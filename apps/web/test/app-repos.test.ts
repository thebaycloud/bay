import { test } from "node:test";
import assert from "node:assert/strict";
import { appForPush, linkRepo, refreshRepoName, type Query } from "../lib/app-repos";
import { cloneCommands } from "../lib/source";
import { buildStartSql } from "../lib/builds";
import { fullNameFromUrl } from "../lib/github-repos";

/**
 * The link a push is matched on, the clone that a matched push produces, and
 * the row that records it. Each is asserted against its SQL or its argv rather
 * than against a database, which is what makes them assertable at all.
 */

function fake(rows: Record<string, unknown>[] = []) {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const q: Query = async (sql, params) => { seen.push({ sql, params }); return { rows }; };
  return { q, seen };
}

const ROW = {
  slug: "q13fh",
  installation_id: "155650459",
  repo_id: "42",
  repo_full_name: "thebaycloud/bay",
  branch: "main",
  auto_deploy: true,
  connected_at: "2026-08-23T00:00:00.000Z",
  owner_id: "owner-1",
  workspace_id: "ws-1",
  repo_url: "https://github.com/thebaycloud/bay",
  connected_login: "onlytenders",
};

/**
 * bigint arrives from node-postgres as a string. Coerced once, here, so no
 * caller has to know that — and a caller that compared `"42" === 42` would
 * simply never ship anything.
 */
test("a push target comes back with its bigints as numbers", async () => {
  const { q } = fake([ROW]);
  const t = await appForPush(42, "main", q);
  assert.equal(t?.installationId, 155650459);
  assert.equal(t?.repoId, 42);
  assert.equal(t?.slug, "q13fh");
  assert.equal(t?.connectedLogin, "onlytenders");
});

test("a push is matched on the repository id and the branch, in that order", async () => {
  const { q, seen } = fake([ROW]);
  await appForPush(42, "main", q);
  assert.deepEqual(seen[0].params, [42, "main"]);
  assert.match(seen[0].sql, /r\.repo_id = \$1 AND r\.branch = \$2/);
});

/**
 * "Nobody connected this" and "somebody connected it and turned it off" are
 * different answers, and the webhook says which in its response body. A query
 * that filtered on `auto_deploy` would collapse them and make the switch
 * impossible to debug from GitHub's Advanced tab.
 */
test("a target with auto-deploy off is still returned", async () => {
  const { q } = fake([{ ...ROW, auto_deploy: false }]);
  const t = await appForPush(42, "main", q);
  assert.equal(t?.autoDeploy, false);
});

test("an impossible repo id never becomes a query", async () => {
  const { q, seen } = fake([ROW]);
  for (const [id, branch] of [[0, "main"], [-1, "main"], [1.5, "main"], [42, ""]] as Array<[number, string]>) {
    assert.equal(await appForPush(id, branch, q), null);
  }
  assert.equal(seen.length, 0);
});

/**
 * Re-connecting is how a person moves an app to another repository or branch,
 * and it arrives as the same slug. `auto_deploy` is deliberately not in the
 * update set: somebody who turned it off has not asked for it back.
 */
test("connecting again re-points the link without re-enabling auto-deploy", async () => {
  const { q, seen } = fake();
  await linkRepo({ slug: "q13fh", installationId: 1, repoId: 42, repoFullName: "a/b", branch: "main" }, q);
  assert.match(seen[0].sql, /ON CONFLICT \(slug\) DO UPDATE/);
  assert.doesNotMatch(seen[0].sql, /auto_deploy/);
});

test("a rename updates the stored name only when it actually moved", async () => {
  const { q, seen } = fake();
  await refreshRepoName(42, "thebaycloud/renamed", q);
  assert.match(seen[0].sql, /repo_full_name <> \$2/);
  assert.deepEqual(seen[0].params, [42, "thebaycloud/renamed"]);
});

const SHA = "9f2c1a4b8e7d6c5b4a3928170615243342516170";

/**
 * `git clone --branch` takes a branch or a tag and refuses a SHA, so pinning
 * cannot be a flag on the clone we already make.
 */
test("an unpinned clone is exactly the shallow clone it has always been", () => {
  assert.deepEqual(cloneCommands("https://github.com/a/b.git", "/tmp/d"), [
    ["git", ["clone", "--depth", "1", "https://github.com/a/b.git", "/tmp/d"]],
  ]);
});

test("a pinned clone fetches the commit itself, one commit deep", () => {
  const cmds = cloneCommands("https://github.com/a/b.git", "/tmp/d", SHA);
  assert.deepEqual(cmds.map((c) => c[1][0] === "-C" ? c[1][2] : c[1][0]), ["init", "remote", "fetch", "checkout"]);
  assert.deepEqual(cmds[2][1], ["-C", "/tmp/d", "fetch", "--depth", "1", "origin", SHA]);
  assert.deepEqual(cmds[3][1], ["-C", "/tmp/d", "checkout", "--detach", "FETCH_HEAD"]);
});

/**
 * Four columns that are always null together. A build with no commit must
 * produce exactly the statement it produced before commits existed — a push
 * cannot change what an upload records.
 */
test("a build with no commit writes the three columns it always did", () => {
  const q = buildStartSql("run-1", "q13fh", "you");
  assert.match(q.text, /INSERT INTO builds\(run_id, slug, who\)/);
  assert.deepEqual(q.values, ["run-1", "q13fh", "you"]);
});

test("a build caused by a push carries the commit into the row", () => {
  const q = buildStartSql("run-1", "q13fh", "someone", {
    sha: SHA, branch: "main", message: "One clock is the clock", author: "Rakhat",
  });
  assert.match(q.text, /commit_sha, commit_branch, commit_message, commit_author/);
  assert.deepEqual(q.values, ["run-1", "q13fh", "someone", SHA, "main", "One clock is the clock", "Rakhat"]);
});

/**
 * The URL door still takes GitLab, a self-hosted git and a `file://` path, and
 * none of those can be connected to a push — so "not a GitHub URL" is a real
 * answer rather than a failure.
 */
test("owner/repo is read out of every shape a GitHub url arrives in", () => {
  for (const url of [
    "https://github.com/thebaycloud/bay",
    "https://github.com/thebaycloud/bay.git",
    "https://github.com/thebaycloud/bay/",
    "github.com/thebaycloud/bay",
    "https://x-access-token:ghs_secret@github.com/thebaycloud/bay.git",
  ]) {
    assert.equal(fullNameFromUrl(url), "thebaycloud/bay", url);
  }
  for (const url of ["https://gitlab.com/a/b", "file:///tmp/x", "", "https://github.com/thebaycloud"]) {
    assert.equal(fullNameFromUrl(url), "", url);
  }
});

/**
 * The build context is the whole directory, `.git` included, and a Dockerfile
 * that says `COPY . .` would copy an installation token into a layer of an
 * image pushed to a shared repository. The token lives an hour; an image layer
 * does not.
 */
test("a clone with a credential does not leave it in .git/config", () => {
  const authed = "https://x-access-token:ghs_secret@github.com/a/b.git";
  const clean = "https://github.com/a/b.git";
  for (const cmds of [cloneCommands(authed, "/tmp/d", undefined, clean), cloneCommands(authed, "/tmp/d", SHA, clean)]) {
    const last = cmds[cmds.length - 1];
    assert.deepEqual(last[1], ["-C", "/tmp/d", "remote", "set-url", "origin", clean]);
  }
});

test("a public clone runs exactly the one command it always ran", () => {
  const url = "https://github.com/a/b.git";
  assert.equal(cloneCommands(url, "/tmp/d", undefined, url).length, 1);
});
