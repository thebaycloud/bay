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

export async function markAppLive(slug: string, runUrl: string, releaseHash?: string | null): Promise<void> {
  // The hash is written in the same statement that marks the app live, so the live
  // release and the hash a redeploy compares against can never disagree. Passing
  // nothing clears it, which is right for a cloud build: we did not hash that output,
  // so no later deploy should believe it matches.
  await getPool(DB).query(
    `UPDATE apps SET run_url = $2, status = 'live', release_hash = $3 WHERE slug = $1`,
    [slug, runUrl, releaseHash ?? null]
  );
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
