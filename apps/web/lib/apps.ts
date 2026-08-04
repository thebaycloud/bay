import { getPool } from "./db";

const DB = "supersonic_platform";

export type Visibility = "private" | "shared" | "workspace" | "public";

export interface AppRecord {
  id: string;
  slug: string;
  workspace_id: string;
  owner_id: string;
  run_url: string | null;
  visibility: Visibility;
  status: "deploying" | "live" | "failed";
}

/** Insert (or reclaim) the row for a slug. Called BEFORE the deploy runs. */
export async function createAppRecord(o: {
  slug: string; workspaceId: string; ownerId: string;
}): Promise<string> {
  const r = await getPool(DB).query(
    `INSERT INTO apps(slug, workspace_id, owner_id, status)
     VALUES($1, $2, $3, 'deploying')
     ON CONFLICT(slug) DO UPDATE SET status = 'deploying'
     RETURNING id`,
    [o.slug, o.workspaceId, o.ownerId]
  );
  return r.rows[0].id;
}

export async function markAppLive(
  slug: string,
  runUrl: string,
  releaseHash?: string | null,
  routes?: { path: string; url: string }[] | null,
  /**
   * Whether this deploy produced a web process. Optional only because TypeScript
   * forbids a required parameter after an optional one; every call site passes
   * it explicitly, and none should be allowed to stop. Omitting it leaves the
   * stored value alone rather than asserting a web process exists.
   */
  hasWeb?: boolean,
): Promise<void> {
  // The hash is written in the same statement that marks the app live, so the live
  // release and the hash a redeploy compares against can never disagree. Passing
  // nothing clears it, which is right for a cloud build: we did not hash that output,
  // so no later deploy should believe it matches.
  //
  // Routes are written the same way and for the same reason: an app that has just
  // gone live with two services must not be reachable for even one request with
  // the routes of the deploy before it. Null clears them, so an app that drops
  // back to a single service stops being split.
  //
  // `has_web` is written the same way again, and is the reason an app with no
  // web process stops being described as a broken one. COALESCE, not a bare
  // assignment: a caller that passes nothing must leave the stored value alone,
  // because silently writing `true` would take a worker-only app that was
  // correctly marked and put it back to answering "This deploy stopped".
  //
  // Written defensively: `routes` arrives in a migration, and a control plane
  // that has shipped ahead of it must NOT fail every deploy at the moment it goes
  // live. Marking an app live is the last thing a deploy does, so a failure here
  // discards a build that actually worked. The column is used when present and
  // skipped when not.
  //
  // The alternation in the pattern below is load-bearing and was nearly the
  // whole value of this change reversed. Postgres names the missing column in
  // the message, so a pattern matching only `routes` does not match
  // `column "has_web" of relation "apps" does not exist` — it rethrows, and
  // every deploy in the platform fails at go-live on a database that has not
  // been migrated yet. Any column added here must be added to this pattern and
  // dropped from the fallback query in the same edit.
  try {
    await getPool(DB).query(
      `UPDATE apps SET run_url = $2, status = 'live', release_hash = $3, routes = $4::jsonb,
              has_web = COALESCE($5, apps.has_web) WHERE slug = $1`,
      [slug, runUrl, releaseHash ?? null, routes && routes.length ? JSON.stringify(routes) : null, hasWeb ?? null]
    );
  } catch (e) {
    if (!/column .*(routes|has_web).* does not exist/i.test(e instanceof Error ? e.message : String(e))) throw e;
    await getPool(DB).query(
      `UPDATE apps SET run_url = $2, status = 'live', release_hash = $3 WHERE slug = $1`,
      [slug, runUrl, releaseHash ?? null]
    );
  }
}

export interface OwnedApp {
  slug: string;
  name: string;
  url: string;
  ready: boolean;
  status: "deploying" | "live" | "failed";
  visibility: Visibility;
  createdAt: string;
}

/**
 * Every app a person owns, from the database.
 *
 * This used to come from Cloud Run: list every service in the project, then keep
 * the ones whose owner label matches. That was wrong twice over. It cost a listing
 * of the entire platform on every dashboard load — so the page got slower for
 * everyone each time anybody deployed anything — and it could not see static apps
 * at all, because they have no Cloud Run service of their own; one shared server
 * fronts all of them. The sidebar counted from this table and said "1", the list
 * counted from Cloud Run and said "0", and the app was live the whole time.
 *
 * `deploys` carries the friendly name the person deployed under; an app that
 * predates that table falls back to its slug.
 */
export async function listOwnedApps(ownerId: string): Promise<OwnedApp[]> {
  if (!ownerId) return [];
  const r = await getPool(DB).query(
    `SELECT a.slug,
            COALESCE(NULLIF(d.name, ''), a.slug) AS name,
            a.run_url,
            a.status,
            a.visibility,
            a.created_at
       FROM apps a
       LEFT JOIN deploys d ON d.slug = a.slug
      WHERE a.owner_id = $1 AND a.status <> 'failed'
      ORDER BY a.created_at DESC`,
    [ownerId]
  );
  return r.rows.map((row) => ({
    slug: row.slug,
    name: row.name,
    // A static app's run_url points at the shared static server, which is useless
    // to show someone — their app lives at its own name.
    url: `https://${row.slug}.supersonic.cv`,
    ready: row.status === "live",
    status: row.status,
    visibility: row.visibility,
    createdAt: row.created_at?.toISOString?.() ?? String(row.created_at ?? ""),
  }));
}

/** The content hash of the live release, or null if there isn't one. */
export async function liveReleaseHash(slug: string, ownerId: string): Promise<string | null> {
  const r = await getPool(DB).query(
    `SELECT release_hash FROM apps WHERE slug = $1 AND owner_id = $2 AND status = 'live'`,
    [slug, ownerId]
  );
  return r.rows[0]?.release_hash ?? null;
}

export async function markAppFailed(slug: string): Promise<void> {
  await getPool(DB).query(`UPDATE apps SET status = 'failed' WHERE slug = $1`, [slug]);
}

export async function getAppBySlug(slug: string): Promise<AppRecord | null> {
  const r = await getPool(DB).query(`SELECT * FROM apps WHERE slug = $1`, [slug]);
  return r.rows[0] ?? null;
}

export async function setVisibility(slug: string, v: Visibility): Promise<void> {
  await getPool(DB).query(`UPDATE apps SET visibility = $2 WHERE slug = $1`, [slug, v]);
}

export async function listGrants(slug: string): Promise<string[]> {
  const r = await getPool(DB).query(
    `SELECT g.email FROM app_grants g JOIN apps a ON a.id = g.app_id
     WHERE a.slug = $1 ORDER BY g.email`,
    [slug]
  );
  return r.rows.map((x: { email: string }) => x.email);
}

export async function addGrant(slug: string, email: string): Promise<void> {
  await getPool(DB).query(
    `INSERT INTO app_grants(app_id, email)
     SELECT a.id, $2 FROM apps a WHERE a.slug = $1
     ON CONFLICT DO NOTHING`,
    [slug, email.trim().toLowerCase()]
  );
}

export async function removeGrant(slug: string, email: string): Promise<void> {
  await getPool(DB).query(
    `DELETE FROM app_grants g USING apps a
     WHERE g.app_id = a.id AND a.slug = $1 AND g.email = $2`,
    [slug, email.trim().toLowerCase()]
  );
}
