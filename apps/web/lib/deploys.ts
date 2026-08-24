import { getPool } from "./db";
import { NODE_RESTART_STAGES } from "./stage-names";

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
const TERMINAL_STATUSES = new Set(["live", "failed"]);

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

/** When an app last finished deploying, and how long that deploy ran. */
export interface DeploySummary {
  /** ISO instant the deploy finished. */
  at: string;
  /** Wall-clock milliseconds, or null when nothing timed that run. */
  durationMs: number | null;
}

/**
 * The last finished deploy of every app a person owns.
 *
 * "Deployed" comes from `deploys`, which keeps one row per slug — the latest.
 * `finished_at` postdates that table, so a row written before it falls back to
 * `updated_at`: a terminal deploy's last write IS the moment it finished.
 *
 * The duration comes from `deploy_stages`, because `deploys` never recorded a
 * start — only the end. The stages of one run are recovered by their nearness to
 * that end rather than by a run id, which the table does not have; a window of
 * half an hour is longer than any deploy we have measured and shorter than the
 * gap between two of them in practice. Stages predate this too, so an app that
 * last deployed before that table shows a date and no duration, which is the
 * honest answer rather than a computed guess.
 */
export async function lastDeploySummaries(ownerId: string): Promise<Record<string, DeploySummary>> {
  if (!ownerId) return {};
  const out: Record<string, DeploySummary> = {};
  try {
    await ensure();
    const r = await getPool(DB).query(
      `SELECT d.slug,
              to_char(COALESCE(d.finished_at, d.updated_at) AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
              EXTRACT(EPOCH FROM (st.ended - st.started)) * 1000 AS ms
         FROM deploys d
         LEFT JOIN LATERAL (
           -- Scoped to ONE deploy by its run id, and only falling back to the
           -- time window for rows written before that column existed.
           --
           -- The window alone folded every attempt in half an hour into a single
           -- duration. Measured on the dashboard's own cards: an app whose deploy
           -- took 1m 34s from build start to publish was shown as 23m 57s,
           -- because four attempts and a repair-agent run preceded it. The error
           -- is always upward and grows with how often somebody redeploys, so the
           -- number lied hardest while a person was debugging and reading it most.
           --
           -- ${NODE_RESTART_STAGES.join(" and ")} are excluded from "latest": both
           -- are written with run_id always null, off the node's own sync, on
           -- every successful process start rather than only on a deploy — see
           -- lib/stage-names.ts. Left in, one could BE the newest row for a slug
           -- (a crash-loop restart or a node reboot after the real deploy
           -- finished), which would force latest.run_id to null and drop this
           -- lookup into the legacy window branch below for an app that has a
           -- perfectly good run id — the exact mistake this run-id scoping exists
           -- to end, arriving through a stage nothing here knew to distrust.
           WITH latest AS (
             SELECT s.run_id
               FROM deploy_stages s
              WHERE s.slug = d.slug
                AND s.started_at <= COALESCE(d.finished_at, d.updated_at)
                AND s.stage NOT IN (${NODE_RESTART_STAGES.map((s) => `'${s}'`).join(", ")})
              ORDER BY s.started_at DESC
              LIMIT 1
           )
           SELECT min(s.started_at) AS started,
                  max(COALESCE(s.ended_at, s.started_at)) AS ended
             FROM deploy_stages s, latest
            WHERE s.slug = d.slug
              AND s.started_at <= COALESCE(d.finished_at, d.updated_at)
              AND (
                (latest.run_id IS NOT NULL AND s.run_id = latest.run_id)
                OR (latest.run_id IS NULL AND s.run_id IS NULL
                    AND s.started_at > COALESCE(d.finished_at, d.updated_at) - interval '30 minutes')
              )
         ) st ON TRUE
        WHERE d.owner_id = $1 AND d.status <> 'building'`,
      [ownerId],
    );
    for (const row of r.rows) {
      if (!row.at) continue;
      const ms = row.ms === null || row.ms === undefined ? null : Number(row.ms);
      out[row.slug] = { at: row.at, durationMs: ms !== null && ms > 0 ? Math.round(ms) : null };
    }
    return out;
  } catch {
    // deploy_stages is a separate migration; a control plane running ahead of it
    // should still be able to say when an app last deployed.
    try {
      const r = await getPool(DB).query(
        `SELECT slug, to_char(COALESCE(finished_at, updated_at) AT TIME ZONE 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
           FROM deploys WHERE owner_id = $1 AND status <> 'building'`,
        [ownerId],
      );
      for (const row of r.rows) if (row.at) out[row.slug] = { at: row.at, durationMs: null };
    } catch { /* the dashboard renders without it */ }
    return out;
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

/**
 * Who a slug belongs to, according to its deploy record.
 *
 * The last identity still attached to an app whose `apps` row has already been
 * removed — which is what makes a half-deleted app deletable at all.
 */
export async function deployOwner(slug: string): Promise<string | null> {
  try {
    await ensure();
    const r = await getPool(DB).query("SELECT owner_id FROM deploys WHERE slug = $1", [slug]);
    return r.rows[0]?.owner_id ?? null;
  } catch {
    return null;
  }
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
