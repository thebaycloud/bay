import { getPool } from "./db";

const DB = "supersonic_platform";

// A tiny store of in-flight deploys so the dashboard can show live progress for
// deploys started anywhere (CLI included) — not just the tab that kicked one off.

let ensured: Promise<void> | null = null;
function ensure(): Promise<void> {
  if (!ensured) {
    ensured = getPool(DB).query(
      `CREATE TABLE IF NOT EXISTS deploys (
         slug        text PRIMARY KEY,
         owner_id    text,
         name        text,
         status      text NOT NULL DEFAULT 'building',
         stage       text,
         url         text,
         updated_at  timestamptz NOT NULL DEFAULT now()
       )`
    ).then(() => undefined).catch((e) => { ensured = null; throw e; });
  }
  return ensured;
}

export interface DeployRow { slug: string; name: string | null; status: string; stage: string | null; url: string | null; }

/** Upsert deploy progress. Fire-and-forget from the deploy stream — never let a
 * DB hiccup break a deploy. */
export async function setDeploy(
  slug: string,
  d: { ownerId?: string | null; name?: string; status?: string; stage?: string; url?: string },
): Promise<void> {
  try {
    await ensure();
    await getPool(DB).query(
      `INSERT INTO deploys(slug, owner_id, name, status, stage, url, updated_at)
         VALUES($1,$2,$3,COALESCE($4,'building'),$5,$6,now())
       ON CONFLICT(slug) DO UPDATE SET
         status = COALESCE($4, deploys.status),
         stage  = COALESCE($5, deploys.stage),
         url    = COALESCE($6, deploys.url),
         name   = COALESCE($3, deploys.name),
         owner_id = COALESCE($2, deploys.owner_id),
         updated_at = now()`,
      [slug, d.ownerId ?? null, d.name ?? null, d.status ?? null, d.stage ?? null, d.url ?? null],
    );
  } catch { /* ignore — progress tracking is best-effort */ }
}

/** The latest deploy record for one app (for the Deployments live view). */
export async function getDeploy(slug: string): Promise<DeployRow | null> {
  try {
    await ensure();
    const r = await getPool(DB).query(
      "SELECT slug, name, status, stage, url FROM deploys WHERE slug=$1", [slug],
    );
    return r.rows[0] ?? null;
  } catch {
    return null;
  }
}

/** Deploys still building for a user (ignoring stale ones from crashed deploys). */
export async function listActiveDeploys(ownerId: string): Promise<DeployRow[]> {
  try {
    await ensure();
    const r = await getPool(DB).query(
      `SELECT slug, name, status, stage, url FROM deploys
       WHERE owner_id=$1 AND status='building' AND updated_at > now() - interval '15 minutes'
       ORDER BY updated_at DESC`,
      [ownerId],
    );
    return r.rows;
  } catch {
    return [];
  }
}

/**
 * The slug a person's project already has, matched by the name they deploy under.
 *
 * resolveSlug used to answer this from Cloud Run labels alone, which works only for
 * apps that own a Cloud Run service. Static apps do not: they are served by one shared
 * service, so there was nothing to carry a label and every redeploy minted a fresh slug
 * and a brand new app. Found by deploying the same project twice — the second run
 * created a second app instead of updating the first.
 *
 * This table already records (owner, name) -> slug for every deploy from anywhere, so
 * it is the answer for both kinds.
 */
export async function slugForName(ownerId: string, name: string): Promise<string | null> {
  if (!ownerId || !name) return null;
  try {
    await ensure();
    const r = await getPool(DB).query(
      `SELECT slug FROM deploys
        WHERE owner_id = $1 AND name = $2 AND status <> 'failed'
        ORDER BY updated_at DESC LIMIT 1`,
      [ownerId, name]
    );
    return r.rows[0]?.slug ?? null;
  } catch {
    // A lookup failure must mean "new app", never a failed deploy.
    return null;
  }
}
