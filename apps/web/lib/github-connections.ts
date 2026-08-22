import { getPool } from "./db";

/**
 * Which GitHub installations a workspace owns.
 *
 * The module is small and one function in it is load-bearing:
 * `workspaceOwnsInstallation` is the only thing standing between an
 * installation id in a request body and a token scoped to somebody's private
 * code. An installation id is not a secret — it is in a redirect URL, in
 * GitHub's own UI, and it is a small integer. So it must never be treated as
 * proof of anything, and every route that mints asks this first.
 *
 * Deliberately knows nothing about GitHub. Whether a token CAN be minted is
 * lib/github-app.ts's question; whether this caller MAY is this one's, and a
 * module that answered both would let one be mistaken for the other.
 */

export type Query = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const pool: Query = (sql, params) => getPool("supersonic_platform").query(sql, params);

export interface Connection {
  installationId: number;
  workspaceId: string;
  accountLogin: string;
  accountType: string;
  connectedBy: string | null;
}

/**
 * Whether a value could be an installation id at all.
 *
 * Cheap, and it runs before the query rather than after: an id that cannot
 * exist should not become a database round trip, and `NaN` reaching a bigint
 * parameter is an error from the driver rather than a false.
 */
function plausible(id: number): boolean {
  return Number.isInteger(id) && id > 0;
}

/**
 * Upsert, because installing the App again on the same account is the normal
 * way a person repairs a connection — and it arrives as the same installation
 * id. An INSERT here would fail on the primary key and the repair would read as
 * a bug.
 *
 * `connected_by` is COALESCEd rather than overwritten so a re-install by a
 * second person does not erase who set it up originally, while a first
 * connection made by nobody in particular can still be claimed later.
 */
export async function recordInstallation(c: Connection, q: Query = pool): Promise<void> {
  await q(
    `INSERT INTO github_installations
       (installation_id, workspace_id, account_login, account_type, connected_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (installation_id) DO UPDATE SET
       workspace_id  = EXCLUDED.workspace_id,
       account_login = EXCLUDED.account_login,
       account_type  = EXCLUDED.account_type,
       connected_by  = COALESCE(EXCLUDED.connected_by, github_installations.connected_by),
       updated_at    = now()`,
    [c.installationId, c.workspaceId, c.accountLogin, c.accountType, c.connectedBy],
  );
}

export async function connectionsForWorkspace(workspaceId: string, q: Query = pool): Promise<Connection[]> {
  // An empty workspace id must not reach the WHERE clause. The difference
  // between "no connections" and "every connection on the platform" should not
  // depend on how Postgres compares uuid to ''.
  if (!workspaceId) return [];
  const { rows } = await q(
    `SELECT installation_id, workspace_id, account_login, account_type, connected_by
       FROM github_installations
      WHERE workspace_id = $1
      ORDER BY account_login`,
    [workspaceId],
  );
  return rows.map((r) => ({
    // bigint arrives as a string through node-postgres. Coerced here, once, so
    // no caller has to know that and none can forget.
    installationId: Number(r.installation_id),
    workspaceId: String(r.workspace_id),
    accountLogin: String(r.account_login),
    accountType: String(r.account_type),
    connectedBy: r.connected_by == null ? null : String(r.connected_by),
  }));
}

export async function workspaceOwnsInstallation(
  workspaceId: string,
  installationId: number,
  q: Query = pool,
): Promise<boolean> {
  if (!workspaceId || !plausible(installationId)) return false;
  const { rows } = await q(
    `SELECT installation_id FROM github_installations
      WHERE workspace_id = $1 AND installation_id = $2`,
    [workspaceId, installationId],
  );
  return rows.length > 0;
}
