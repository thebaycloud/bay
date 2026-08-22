import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recordInstallation, connectionsForWorkspace, workspaceOwnsInstallation, type Query,
} from "../lib/github-connections";

/**
 * The record, and the one question every route asks it.
 *
 * `workspaceOwnsInstallation` is the security boundary of this whole phase.
 * Without it, an installation id is a bearer token in a request body: anyone
 * who can guess or read one mints a token scoped to somebody else's private
 * code. It is asserted here against the wrong workspace, a missing row, and a
 * junk id, because those are the three ways a check like this is bypassed.
 */

const W = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

/** A fake pool that answers from a list of rows and records what it was asked. */
function db(rows: Record<string, unknown>[] = []) {
  const asked: Array<{ sql: string; params: unknown[] }> = [];
  const q: Query = async (sql, params) => {
    asked.push({ sql, params });
    return { rows };
  };
  return { q, asked };
}

test("recording an installation upserts, so re-installing is not a duplicate", async () => {
  const { q, asked } = db();
  await recordInstallation(
    { installationId: 155650459, workspaceId: W, accountLogin: "thebaycloud", accountType: "Organization", connectedBy: null },
    q,
  );
  assert.equal(asked.length, 1);
  assert.match(asked[0].sql, /ON CONFLICT \(installation_id\) DO UPDATE/);
  assert.deepEqual(asked[0].params, [155650459, W, "thebaycloud", "Organization", null]);
});

test("connections come back typed, with the id as a number", async () => {
  // Postgres returns bigint as a string through node-postgres. A caller that
  // compares it to a number gets false and no error.
  const { q } = db([{
    installation_id: "155650459", workspace_id: W,
    account_login: "thebaycloud", account_type: "Organization", connected_by: null,
  }]);
  const list = await connectionsForWorkspace(W, q);
  assert.equal(list.length, 1);
  assert.strictEqual(list[0].installationId, 155650459);
  assert.equal(list[0].accountLogin, "thebaycloud");
});

test("a workspace owns an installation only when the row says so", async () => {
  const hit = db([{ installation_id: "155650459" }]);
  assert.equal(await workspaceOwnsInstallation(W, 155650459, hit.q), true);
  assert.deepEqual(hit.asked[0].params, [W, 155650459]);

  const miss = db([]);
  assert.equal(await workspaceOwnsInstallation(OTHER, 155650459, miss.q), false);
});

test("a junk installation id is refused without touching the database", async () => {
  const { q, asked } = db([{ installation_id: "1" }]);
  assert.equal(await workspaceOwnsInstallation(W, Number.NaN, q), false);
  assert.equal(await workspaceOwnsInstallation(W, 0, q), false);
  assert.equal(await workspaceOwnsInstallation(W, -5, q), false);
  assert.equal(await workspaceOwnsInstallation(W, 1.5, q), false);
  assert.equal(asked.length, 0, "asked the database about an id that cannot exist");
});

test("no workspace means no ownership, and no query", async () => {
  const { q, asked } = db([{ installation_id: "1" }]);
  assert.equal(await workspaceOwnsInstallation("", 1, q), false);
  assert.equal(asked.length, 0);
});

test("an empty workspace lists nothing rather than everything", async () => {
  // A missing workspace id reaching the WHERE clause is the difference between
  // "no connections" and "every connection on the platform".
  const { q, asked } = db([{ installation_id: "1", workspace_id: OTHER, account_login: "x", account_type: "User", connected_by: null }]);
  assert.deepEqual(await connectionsForWorkspace("", q), []);
  assert.equal(asked.length, 0);
});
