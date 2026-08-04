import { Pool } from "pg";
import { createHash } from "node:crypto";
import { parseRoutes, type Route } from "./routes";

export interface AppRow {
  id: string;
  slug: string;
  workspace_id: string;
  owner_id: string;
  owner_email: string;
  run_url: string | null;
  visibility: "private" | "shared" | "workspace" | "public";
  status: "deploying" | "live" | "failed";
  /** The latest deploy record, so the edge can tell "still building" from "died". */
  deploy: { status: string; error: string | null; updatedAt: number | null } | null;
  /** Path-prefix routes when the app has more than one service. Null for the rest. */
  routes: Route[] | null;
  /** False only for an app that runs no web process — a bot, a queue, a cron. */
  has_web: boolean;
}

const CACHE_MS = 30_000;
/**
 * A row mid-deploy is cached for barely any time at all.
 *
 * The flat 30s made a deploy's own success invisible for up to half a minute
 * after it landed: the app was live, the row said so, and the URL went on
 * serving "Deploying…" out of a cache nothing invalidates. Half a minute is a
 * long time to stare at a page that is lying to you, and the ONLY rows this
 * affects are ones we already know are about to change — an app that is live or
 * failed still gets the full window, which is where all the traffic is.
 */
const CACHE_MS_DEPLOYING = 2_000;
const ttlFor = (row: AppRow | null) => (row && row.status === "deploying" ? CACHE_MS_DEPLOYING : CACHE_MS);
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
  if (hit && Date.now() - hit.at < ttlFor(hit.row)) return hit.row;

  // The deploys row rides along because apps.status alone cannot distinguish a
  // deploy that is working from one whose process died: both read 'deploying'
  // forever. `deploy_updated_at` is when that deploy last reported progress, and
  // `deploy_error` is the reason a failed one gives.
  const r = await db().query(
    `SELECT a.*, u.email AS owner_email,
            d.status AS deploy_status,
            d.error  AS deploy_error,
            d.updated_at AS deploy_updated_at
     FROM apps a
     JOIN users u ON u.id = a.owner_id
     LEFT JOIN deploys d ON d.slug = a.slug
     WHERE a.slug = $1`,
    [slug]
  );
  const raw = r.rows[0] as (AppRow & {
    deploy_status?: string | null;
    deploy_error?: string | null;
    deploy_updated_at?: Date | null;
  }) | undefined;
  const row: AppRow | null = raw
    ? {
        ...raw,
        routes: parseRoutes((raw as unknown as { routes?: unknown }).routes),
        // Normalised here rather than left to spread, because `SELECT a.*` on a
        // database without the column yields undefined while the type above
        // promises a boolean — and the edge decides on `has_web === false`.
        // An absent column must read as "has a web process", which is what
        // every app was assumed to have before the column existed.
        has_web: (raw as unknown as { has_web?: unknown }).has_web !== false,
        deploy: raw.deploy_status
          ? {
              status: raw.deploy_status,
              error: raw.deploy_error ?? null,
              updatedAt: raw.deploy_updated_at ? new Date(raw.deploy_updated_at).getTime() : null,
            }
          : null,
      }
    : null;
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

/** Resolve a CLI bearer token to its owner's user id — for authorising a tunnel. */
export async function userIdFromToken(token: string): Promise<string | null> {
  if (!token) return null;
  const hash = createHash("sha256").update(token).digest("hex");
  const r = await db().query(`SELECT user_id FROM cli_tokens WHERE token_hash = $1`, [hash]);
  return r.rows[0]?.user_id ?? null;
}
