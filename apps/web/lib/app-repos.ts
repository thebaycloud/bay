import { getPool } from "./db";

/**
 * Every read and write of `app_repos`, and nothing else touches that table.
 *
 * The table is small and one query in it is load-bearing: `appForPush` is what
 * turns an event GitHub sends to everybody into a build of one particular app.
 * It runs on a path a person is watching, it runs with no session behind it,
 * and it is the only thing that decides whether a push means anything at all.
 *
 * Deliberately knows nothing about GitHub. Whether a push is well-formed is
 * lib/github-webhook.ts's question; whether anybody asked for it is this one's.
 */

export type Query = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const pool: Query = (sql, params) => getPool("supersonic_platform").query(sql, params);

/**
 * The binding to write once an app row exists.
 *
 * Carried through a deploy rather than written by the route, because
 * `app_repos.slug` references `apps.slug` — so the link cannot exist until
 * `createAppRecord` has run, which happens inside the pipeline. The ordering is
 * forced by the schema, not chosen.
 */
export interface RepoLink {
  installationId: number;
  repoId: number;
  repoFullName: string;
  branch: string;
}

/** One app's connected repository, as everything but the dispatcher needs it. */
export interface AppRepo {
  slug: string;
  installationId: number;
  repoId: number;
  repoFullName: string;
  branch: string;
  autoDeploy: boolean;
  connectedAt: Date | null;
}

/**
 * What a push needs to become a build: the link, plus the two fields on `apps`
 * that a dispatch cannot be assembled without.
 *
 * Joined rather than fetched separately because the alternative is two round
 * trips on the latency path and a window in which the app is deleted between
 * them — which would dispatch a build for a slug that no longer exists.
 */
export interface PushTarget extends AppRepo {
  ownerId: string;
  workspaceId: string;
  repoUrl: string | null;
  /** The login that connected the account, or null for an organisation. */
  connectedLogin: string | null;
}

function toRepo(r: Record<string, unknown>): AppRepo {
  return {
    slug: String(r.slug),
    // bigint arrives as a string through node-postgres. Coerced here, once, so
    // no caller has to know that and none can forget — the same rule
    // lib/github-connections.ts states for the same reason.
    installationId: Number(r.installation_id),
    repoId: Number(r.repo_id),
    repoFullName: String(r.repo_full_name),
    branch: String(r.branch),
    autoDeploy: r.auto_deploy !== false,
    connectedAt: r.connected_at ? new Date(String(r.connected_at)) : null,
  };
}

/**
 * Connect an app to a branch, or re-point one that is already connected.
 *
 * Upsert, because re-connecting is how a person moves an app to a different
 * repository or a different branch, and it arrives as the same slug. An INSERT
 * would fail on the primary key and the ordinary act would read as a bug.
 *
 * `auto_deploy` is NOT in the DO UPDATE set. Somebody who turned it off and
 * later re-points the branch has not asked for it back, and silently
 * re-enabling it would start shipping on a push they thought they had stopped.
 */
export async function linkRepo(
  o: { slug: string; installationId: number; repoId: number; repoFullName: string; branch: string },
  q: Query = pool,
): Promise<void> {
  await q(
    `INSERT INTO app_repos (slug, installation_id, repo_id, repo_full_name, branch)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (slug) DO UPDATE SET
       installation_id = EXCLUDED.installation_id,
       repo_id         = EXCLUDED.repo_id,
       repo_full_name  = EXCLUDED.repo_full_name,
       branch          = EXCLUDED.branch,
       connected_at    = now()`,
    [o.slug, o.installationId, o.repoId, o.repoFullName, o.branch],
  );
}

export async function repoForSlug(slug: string, q: Query = pool): Promise<AppRepo | null> {
  if (!slug) return null;
  const { rows } = await q(`SELECT * FROM app_repos WHERE slug = $1`, [slug]);
  return rows[0] ? toRepo(rows[0]) : null;
}

/**
 * The app a push belongs to, or null.
 *
 * Matched on `(repo_id, branch)` — the id rather than the name, so a repository
 * renamed in GitHub keeps shipping. Returns the row even when `auto_deploy` is
 * off: "nobody connected this" and "somebody connected it and turned it off"
 * are different answers, the webhook says which in its response body, and a
 * query that collapsed them would make the switch impossible to debug.
 */
export async function appForPush(repoId: number, branch: string, q: Query = pool): Promise<PushTarget | null> {
  if (!Number.isInteger(repoId) || repoId <= 0 || !branch) return null;
  const { rows } = await q(
    `SELECT r.*, a.owner_id, a.workspace_id, a.repo_url, i.connected_login
       FROM app_repos r
       JOIN apps a ON a.slug = r.slug
       JOIN github_installations i ON i.installation_id = r.installation_id
      WHERE r.repo_id = $1 AND r.branch = $2`,
    [repoId, branch],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ...toRepo(row),
    ownerId: String(row.owner_id),
    workspaceId: String(row.workspace_id),
    repoUrl: row.repo_url == null ? null : String(row.repo_url),
    connectedLogin: row.connected_login == null ? null : String(row.connected_login),
  };
}

/**
 * Keep the stored name in step with GitHub's.
 *
 * Called from the webhook on every push, because a rename produces no event we
 * subscribe to — the first time we hear about it is the next push, in a payload
 * that carries the new name beside the unchanged id. Writing it here is what
 * keeps the display name and the API paths from going stale silently.
 *
 * A no-op when the name has not moved, so the common push costs one cheap
 * UPDATE that matches nothing.
 */
export async function refreshRepoName(repoId: number, fullName: string, q: Query = pool): Promise<void> {
  if (!Number.isInteger(repoId) || repoId <= 0 || !fullName) return;
  await q(
    `UPDATE app_repos SET repo_full_name = $2 WHERE repo_id = $1 AND repo_full_name <> $2`,
    [repoId, fullName],
  );
}

export async function setBranch(slug: string, branch: string, q: Query = pool): Promise<void> {
  await q(`UPDATE app_repos SET branch = $2 WHERE slug = $1`, [slug, branch]);
}

export async function setAutoDeploy(slug: string, on: boolean, q: Query = pool): Promise<void> {
  await q(`UPDATE app_repos SET auto_deploy = $2 WHERE slug = $1`, [slug, on]);
}

export async function unlinkRepo(slug: string, q: Query = pool): Promise<void> {
  await q(`DELETE FROM app_repos WHERE slug = $1`, [slug]);
}
