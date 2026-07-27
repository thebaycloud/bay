import { Pool } from "pg";

export interface AppRow {
  id: string;
  slug: string;
  workspace_id: string;
  owner_id: string;
  owner_email: string;
  run_url: string | null;
  visibility: "private" | "shared" | "workspace" | "public";
  status: "deploying" | "live" | "failed";
}

const CACHE_MS = 30_000;
/**
 * Cache keys come straight from the Host header, so anyone can mint new ones by
 * walking subdomains — and misses cache too. Bound the map and evict oldest
 * first so enumeration costs a stranger memory on our side, not ours.
 */
const CACHE_MAX = 1000;
const cache = new Map<string, { row: AppRow | null; at: number }>();

function remember(slug: string, row: AppRow | null): void {
  // A Map iterates in insertion order, so the first key is the oldest.
  // Refreshing a key already present replaces it, so nothing needs evicting.
  if (cache.size >= CACHE_MAX && !cache.has(slug)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(slug, { row, at: Date.now() });
}

let pool: Pool | null = null;
function db(): Pool {
  if (pool) return pool;
  const connectionName = process.env.PG_CONN ?? "supersonic-deploy-prod:us-central1:supersonic-shared-pg";
  pool = process.env.K_SERVICE
    ? new Pool({ host: `/cloudsql/${connectionName}`, user: process.env.PG_USER ?? "postgres", password: process.env.PG_PASSWORD, database: "supersonic_platform", max: 5 })
    : new Pool({ host: "127.0.0.1", port: 5433, user: process.env.PG_USER ?? "postgres", password: process.env.PG_PASSWORD, database: "supersonic_platform", max: 5 });
  return pool;
}

export async function lookupApp(slug: string): Promise<AppRow | null> {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.row;

  const r = await db().query(
    `SELECT a.*, u.email AS owner_email
     FROM apps a JOIN users u ON u.id = a.owner_id
     WHERE a.slug = $1`,
    [slug]
  );
  const row = (r.rows[0] as AppRow | undefined) ?? null;
  remember(slug, row);
  return row;
}

/** Does this email have an explicit grant on this app? */
export async function hasGrant(appId: string, email: string): Promise<boolean> {
  const r = await db().query(
    `SELECT 1 FROM app_grants WHERE app_id = $1 AND email = $2`,
    [appId, email.toLowerCase()]
  );
  return r.rowCount ? r.rowCount > 0 : false;
}

/** Workspace of a signed-in visitor, or null if they have no user row yet. */
export async function workspaceOfUser(userId: string): Promise<string | null> {
  const r = await db().query(`SELECT workspace_id FROM users WHERE id = $1`, [userId]);
  return r.rows[0]?.workspace_id ?? null;
}

/** Domain of a workspace, or null if the workspace does not exist. */
export async function workspaceDomainOf(workspaceId: string): Promise<string | null> {
  const r = await db().query(`SELECT domain FROM workspaces WHERE id = $1`, [workspaceId]);
  return r.rows[0]?.domain ?? null;
}
