import { test } from "node:test";
import assert from "node:assert/strict";
import { reposResponse, INSTALL_URL, CONFIGURE_URL } from "../lib/github-import";
import { GithubError } from "../lib/github-app";

/**
 * The import screen's data, and the refusal that matters.
 *
 * An installation id is not a secret — it sits in a redirect URL and in
 * GitHub's own UI. So the assertion worth making is that asking for one this
 * workspace does not own returns 403 and does not list anything, however
 * plausible the id. The others exist so the three broken-connection states stay
 * three states.
 */

const W = "11111111-1111-1111-1111-111111111111";

test("without an installation id, the connections are listed", async () => {
  const r = await reposResponse({
    workspaceId: W,
    installationId: null,
    connections: async () => [{
      installationId: 155650459, workspaceId: W,
      accountLogin: "thebaycloud", accountType: "Organization", connectedBy: null,
    }],
    owns: async () => true,
    repos: async () => { throw new Error("must not list repositories without an id"); },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    connections: [{ installationId: 155650459, accountLogin: "thebaycloud" }],
    installUrl: INSTALL_URL,
    configureUrl: CONFIGURE_URL,
  });
});

test("an installation this workspace owns lists its repositories", async () => {
  const r = await reposResponse({
    workspaceId: W,
    installationId: 155650459,
    connections: async () => [],
    owns: async () => true,
    repos: async () => [{ id: 1, fullName: "thebaycloud/bay", private: true, defaultBranch: "main", pushedAt: null }],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    repos: [{ id: 1, fullName: "thebaycloud/bay", private: true, defaultBranch: "main", pushedAt: null }],
  });
});

test("an installation this workspace does not own is refused, and nothing is listed", async () => {
  let listed = false;
  const r = await reposResponse({
    workspaceId: W,
    installationId: 999,
    connections: async () => [],
    owns: async () => false,
    repos: async () => { listed = true; return []; },
  });
  assert.equal(r.status, 403);
  assert.equal(listed, false, "listed repositories for an installation the workspace does not own");
});

test("a broken connection answers with the kind, not GitHub's prose", async () => {
  const r = await reposResponse({
    workspaceId: W,
    installationId: 1,
    connections: async () => [],
    owns: async () => true,
    repos: async () => { throw new GithubError({ kind: "no-installation", status: 404, message: "Not Found" }); },
  });
  // 409, not 500: the platform is fine and the connection is not, and the
  // screen has something for the person to do about it.
  assert.equal(r.status, 409);
  const body = r.body as { reason: string; message?: string };
  assert.equal(body.reason, "no-installation");
  assert.ok(!JSON.stringify(r.body).includes("Not Found"), "GitHub's prose reached the response");
});

test("credentials of ours being wrong is still 409, and still not GitHub's words", async () => {
  const r = await reposResponse({
    workspaceId: W,
    installationId: 1,
    connections: async () => [],
    owns: async () => true,
    repos: async () => {
      throw new GithubError({ kind: "bad-credentials", status: 401, message: "Integration must generate a public key" });
    },
  });
  assert.equal(r.status, 409);
  assert.equal((r.body as { reason: string }).reason, "bad-credentials");
  assert.ok(!JSON.stringify(r.body).includes("public key"));
});

test("an error that is not GitHub's is not swallowed into a connection problem", async () => {
  // A bug in our own code must not render as "reconnect your account" — the
  // person would spend an afternoon on a link that was never the problem.
  await assert.rejects(
    () => reposResponse({
      workspaceId: W,
      installationId: 1,
      connections: async () => [],
      owns: async () => true,
      repos: async () => { throw new TypeError("undefined is not a function"); },
    }),
    /not a function/,
  );
});

test("the configure link ships with the list, not only with the failure", async () => {
  // Vercel ships a whole knowledge-base page for "I can't see my repository"
  // and the answer is always a narrower selection than the person thinks. The
  // link is the second half of the answer to a question the list provokes.
  const r = await reposResponse({
    workspaceId: W, installationId: null,
    connections: async () => [], owns: async () => true, repos: async () => [],
  });
  const body = r.body as { installUrl: string; configureUrl: string };
  assert.equal(body.installUrl, INSTALL_URL);
  assert.equal(body.configureUrl, CONFIGURE_URL);
  // The shape, asserted once. The App's slug is named in lib/github-import.ts
  // and must not be named again here — a test that hardcodes it becomes the
  // second place to edit when the App changes, and the one nobody remembers.
  for (const u of [INSTALL_URL, CONFIGURE_URL]) {
    assert.match(u, /^https:\/\/github\.com\/apps\/[\w.-]+\/installations\/[\w_]+$/);
  }
});
