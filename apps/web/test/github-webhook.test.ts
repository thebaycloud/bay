import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySignature, webhookConfigured, readPush } from "../lib/github-webhook";

/**
 * The signature is the entire security boundary of `/api/github/webhook`, and
 * `readPush` is what stops an ordinary thing done to a repository — a tag, a
 * branch deleted — from becoming a build.
 *
 * Both are pure, so both are asserted here rather than through a Request.
 */

const SECRET = "a".repeat(64);
const sign = (body: string, key = SECRET) =>
  "sha256=" + createHmac("sha256", key).update(body, "utf8").digest("hex");

beforeEach(() => { process.env.GH_WEBHOOK_SECRET = SECRET; });

test("a body signed with our secret verifies", () => {
  const body = JSON.stringify({ ref: "refs/heads/main" });
  assert.equal(verifySignature(body, sign(body)), true);
});

test("a body signed with a different secret does not", () => {
  const body = JSON.stringify({ ref: "refs/heads/main" });
  assert.equal(verifySignature(body, sign(body, "b".repeat(64))), false);
});

test("one changed byte in the body breaks it", () => {
  const body = JSON.stringify({ ref: "refs/heads/main" });
  const header = sign(body);
  assert.equal(verifySignature(body + " ", header), false);
});

/**
 * Every malformed header is a refusal, never a throw. `timingSafeEqual` rejects
 * buffers of unequal length by raising, so a short header would otherwise be a
 * 500 — the route answering "we broke" to something it should simply refuse.
 */
test("a malformed signature header is refused, not raised", () => {
  const body = "{}";
  for (const header of ["", "sha256=", "sha256=abc", "deadbeef", "sha1=" + "0".repeat(40), null, undefined]) {
    assert.equal(verifySignature(body, header), false, `accepted ${JSON.stringify(header)}`);
  }
});

test("with no secret configured nothing verifies and nothing claims to be configured", () => {
  delete process.env.GH_WEBHOOK_SECRET;
  const body = "{}";
  assert.equal(webhookConfigured(), false);
  assert.equal(verifySignature(body, sign(body)), false);
});

const SHA = "9f2c1a4b8e7d6c5b4a3928170615243342516170";

function push(over: Record<string, unknown> = {}) {
  return {
    ref: "refs/heads/main",
    after: SHA,
    repository: { id: 42, full_name: "thebaycloud/bay" },
    head_commit: { message: "One clock is the clock\n\nand a body nobody renders", author: { name: "Rakhat" } },
    sender: { login: "onlytenders" },
    ...over,
  };
}

test("an ordinary push to a branch is readable", () => {
  const r = readPush(push());
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.push, {
    repoId: 42,
    repoFullName: "thebaycloud/bay",
    branch: "main",
    sha: SHA,
    message: "One clock is the clock",
    author: "Rakhat",
    senderLogin: "onlytenders",
  });
});

test("a branch name with slashes survives intact", () => {
  const r = readPush(push({ ref: "refs/heads/release/2026-08" }));
  assert.equal(r.ok && r.push.branch, "release/2026-08");
});

/**
 * Each of these is a normal thing to do to a repository, so each is a named
 * reason rather than an error — the route puts it in a 200 body and GitHub's
 * Advanced tab shows it.
 */
test("everything that is not a shippable push says why", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ ref: "refs/tags/v1.0.0" }, "not-a-branch"],
    [{ ref: "" }, "not-a-branch"],
    [{ ref: "refs/heads/" }, "not-a-branch"],
    [{ deleted: true }, "branch-deleted"],
    [{ after: "0".repeat(40) }, "branch-deleted"],
    [{ after: "" }, "branch-deleted"],
    [{ after: "not-a-sha" }, "no-commit"],
    [{ repository: {} }, "no-repository"],
    [{ repository: { id: 0, full_name: "x/y" } }, "no-repository"],
  ];
  for (const [over, reason] of cases) {
    const r = readPush(push(over));
    assert.equal(r.ok, false, `shipped ${JSON.stringify(over)}`);
    assert.equal(!r.ok && r.reason, reason, `wrong reason for ${JSON.stringify(over)}`);
  }
});

test("an empty payload is a refusal rather than a crash", () => {
  for (const p of [null, undefined, {}, "", 7]) {
    const r = readPush(p);
    assert.equal(r.ok, false);
  }
});

/**
 * The author is the person who WROTE the commit, and the sender is whoever
 * pushed it. On a merge queue or a rebase-and-merge those differ, and the
 * timeline should show the writer while "who did it" compares the pusher.
 */
test("author and sender are kept apart", () => {
  const r = readPush(push({
    head_commit: { message: "x", author: { name: "Ilmak" } },
    sender: { login: "onlytenders" },
  }));
  assert.equal(r.ok && r.push.author, "Ilmak");
  assert.equal(r.ok && r.push.senderLogin, "onlytenders");
});

test("a commit with no name falls back to the author's username, then to nothing", () => {
  const named = readPush(push({ head_commit: { message: "x", author: { username: "onlytenders" } } }));
  assert.equal(named.ok && named.push.author, "onlytenders");
  const bare = readPush(push({ head_commit: {} }));
  assert.equal(bare.ok && bare.push.author, "");
});
