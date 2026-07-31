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
    // `error` and `finished_at` are what make this row an ANSWER rather than a
    // progress indicator. Until now the only durable record of why a deploy failed
    // was the reason crammed into `stage` — a field the next progress line
    // overwrites — so anything that lost the stream lost the reason with it. And a
    // deploy whose process died left `status='building'` with no end date, which is
    // indistinguishable from one still running. Added separately because the table
    // already exists in production.
    ).then(() => getPool(DB).query(
      `ALTER TABLE deploys
         ADD COLUMN IF NOT EXISTS error       text,
         ADD COLUMN IF NOT EXISTS finished_at timestamptz`
    )).then(() => undefined).catch((e) => { ensured = null; throw e; });
  }
  return ensured;
}

/** The states a deploy can end in. Anything else means it is still running. */
export const TERMINAL_STATUSES = new Set(["live", "failed"]);

export interface DeployRow {
  slug: string;
  name: string | null;
  status: string;
  stage: string | null;
  url: string | null;
  error: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
}

/** Upsert deploy progress. Fire-and-forget from the deploy stream — never let a
 * DB hiccup break a deploy. */
export async function setDeploy(
  slug: string,
  d: { ownerId?: string | null; name?: string; status?: string; stage?: string; url?: string; error?: string },
): Promise<void> {
  try {
    await ensure();
    // A terminal status stamps finished_at in the same write that sets it, so the
    // two can never disagree. A non-terminal one clears it: a redeploy of a
    // previously failed app is running again, and a stale end date would make the
    // proxy and the CLI call it finished.
    const terminal = d.status ? TERMINAL_STATUSES.has(d.status) : null;
    await getPool(DB).query(
      `INSERT INTO deploys(slug, owner_id, name, status, stage, url, error, finished_at, updated_at)
         VALUES($1,$2,$3,COALESCE($4,'building'),$5,$6,$7,
                CASE WHEN $8::boolean THEN now() ELSE NULL END, now())
       ON CONFLICT(slug) DO UPDATE SET
         status = COALESCE($4, deploys.status),
         stage  = COALESCE($5, deploys.stage),
         url    = COALESCE($6, deploys.url),
         -- Explicitly nullable: a redeploy that succeeds must clear the old reason,
         -- so this one is driven by the status, not COALESCEd away.
         error  = CASE WHEN $4 IS NULL THEN deploys.error ELSE $7 END,
         finished_at = CASE WHEN $4 IS NULL THEN deploys.finished_at
                            WHEN $8::boolean THEN now() ELSE NULL END,
         name   = COALESCE($3, deploys.name),
         owner_id = COALESCE($2, deploys.owner_id),
         updated_at = now()`,
      [slug, d.ownerId ?? null, d.name ?? null, d.status ?? null, d.stage ?? null, d.url ?? null,
       d.error ?? null, terminal ?? false],
    );
  } catch { /* ignore — progress tracking is best-effort */ }
}

const SELECT_DEPLOY = `SELECT slug, name, status, stage, url, error,
         to_char(updated_at,  'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "updatedAt",
         to_char(finished_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "finishedAt"
    FROM deploys`;

/** The latest deploy record for one app (for the Deployments live view). */
export async function getDeploy(slug: string): Promise<DeployRow | null> {
  try {
    await ensure();
    const r = await getPool(DB).query(`${SELECT_DEPLOY} WHERE slug=$1`, [slug]);
    return markStale(r.rows[0] ?? null);
  } catch {
    return null;
  }
}

/**
 * How long a deploy may go without reporting before it is presumed dead.
 * Matches the edge's bound (services/proxy/src/edge.ts) on purpose: the
 * dashboard and the URL must not disagree about whether an app is still coming.
 */
const STALE_AFTER_MS = 15 * 60_000;

/**
 * A deploy whose process died writes no terminal status, so its row stays
 * 'building' forever and the dashboard shows "Deploying…" for an app that is
 * never going to arrive — including one that has since been DELETED. Reported as
 * failed once it has been silent long enough. `listActiveDeploys` has always
 * applied this bound in its WHERE clause; reading one row by slug did not.
 */
function markStale(row: DeployRow | null): DeployRow | null {
  if (!row || row.status !== "building") return row;
  const at = row.updatedAt ? Date.parse(row.updatedAt) : NaN;
  if (!Number.isFinite(at) || Date.now() - at <= STALE_AFTER_MS) return row;
  return { ...row, status: "failed", error: row.error || "the deploy stopped reporting and never finished" };
}

/** Forget an app's deploy history. Called when the app itself is deleted. */
export async function deleteDeploy(slug: string): Promise<void> {
  try {
    await ensure();
    await getPool(DB).query("DELETE FROM deploys WHERE slug = $1", [slug]);
  } catch { /* the app is going away regardless */ }
}

/** Deploys still building for a user (ignoring stale ones from crashed deploys). */
export async function listActiveDeploys(ownerId: string): Promise<DeployRow[]> {
  try {
    await ensure();
    const r = await getPool(DB).query(
      `${SELECT_DEPLOY}
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
