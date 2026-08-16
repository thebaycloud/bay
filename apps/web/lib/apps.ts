import { getPool } from "./db";
import { ensureWebsite, umamiConfigured } from "./umami";

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
  /**
   * This app's site inside the shared umami instance, when it has one.
   *
   * Optional on the type as well as nullable in the column: `getAppBySlug` is a
   * `SELECT *`, so on a database that has not run 027 yet the key is simply
   * absent, and a type that promised `string | null` would be lying to every
   * reader in exactly the window where being wrong is most expensive.
   */
  umami_website_id?: string | null;
  analytics_enabled?: boolean;
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
  await provisionAnalytics(o.slug);
  return r.rows[0].id;
}

/**
 * Give this app a site to be counted in, once.
 *
 * Only ever on the way in, and only for an app that has no id yet: this runs on
 * every deploy, not only the first, and umami has no unique constraint that
 * would stop a second site being minted for the same domain. Reading the column
 * first means a redeploy costs one indexed lookup and no network call at all.
 *
 * `try` around the whole thing rather than around each call, and a `catch` that
 * only logs, because the caller is the first step of a deploy. This is the one
 * property this function must have: analytics can be broken, unreachable, or
 * not configured, and the app still ships. Note also the missing-column branch —
 * the control plane deploys ahead of migrations, and a deploy must not start
 * failing in the window between the two.
 */
async function provisionAnalytics(slug: string): Promise<void> {
  if (!umamiConfigured()) return;
  try {
    const cur = await getPool(DB).query(
      `SELECT umami_website_id FROM apps WHERE slug = $1`,
      [slug]
    );
    if (cur.rows[0]?.umami_website_id) return;
    const id = await ensureWebsite(slug);
    if (!id) return;
    await getPool(DB).query(
      `UPDATE apps SET umami_website_id = $2 WHERE slug = $1 AND umami_website_id IS NULL`,
      [slug, id]
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/column .*umami_website_id.* does not exist/i.test(msg)) {
      console.error(`analytics: no site for ${slug} —`, msg);
    }
  }
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
  /** Why the last deploy failed, when it did. From the deploy record. */
  error?: string;
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
 *
 * Failed apps are INCLUDED. They used to be filtered out here, which meant a
 * deploy that failed removed the app from the dashboard entirely: no card, no
 * reason, and no way back to it except knowing the URL. The one moment the
 * product most needs to explain itself was the one moment it went silent. The
 * deploy record's `error` comes along so the card can say what happened.
 *
 * Quotas are unaffected — `lib/entitlements.ts` counts non-failed apps in its
 * own query, so a broken deploy still does not consume a slot.
 */
/**
 * Newest work first, which is not the same as newest app.
 *
 * This ordered by `a.created_at` — the day the app was FIRST deployed — so a
 * throwaway from January outranked the thing shipped twenty minutes ago, and
 * the dashboard's top row was an accident of history rather than an answer to
 * "what am I working on". The last deploy is what changes; the creation date
 * never does.
 *
 * Ordered here rather than in the component on purpose: the list is paged by
 * nothing today, but a sort that lives in the browser is a sort that breaks the
 * moment it is, and both the page render and /api/apps read through this one
 * function. Sorting in SQL means they cannot disagree.
 *
 * `finished_at` arrived in an ALTER (see lib/deploys.ts), so a database that
 * has not run it yet falls back to the old ordering instead of failing the
 * whole dashboard. The apps list is the page; it does not get to 500 over a
 * sort key.
 */
const OWNED_APPS = (order: string) =>
  `SELECT a.slug,
          COALESCE(NULLIF(d.name, ''), a.slug) AS name,
          a.run_url,
          a.status,
          a.visibility,
          a.created_at,
          d.error
     FROM apps a
     LEFT JOIN deploys d ON d.slug = a.slug
    WHERE a.owner_id = $1
    ORDER BY ${order}`;

/** Last deploy, then last progress report, then the day it was created. */
const BY_LAST_DEPLOY = "COALESCE(d.finished_at, d.updated_at, a.created_at) DESC";

/**
 * The orders a person may ask for, as a fixed set.
 *
 * A map rather than a string the caller supplies: this value is interpolated
 * into SQL, so the only safe version is one where the caller picks a KEY and
 * never writes the clause. `sortOf` turns anything at all — a query string, a
 * typo, a hand-edited URL — into one of these three.
 */
export type AppSort = "deployed" | "name" | "oldest";
const ORDER: Record<AppSort, string> = {
  deployed: BY_LAST_DEPLOY,
  name: "lower(COALESCE(NULLIF(d.name, ''), a.slug)) ASC",
  // The inverse of `deployed`, which is what "oldest" means next to "recent".
  // This was `a.created_at DESC` — newest app first, by the date it was FIRST
  // deployed — so it read as a third spelling of the default and looked like a
  // button that did nothing.
  oldest: "COALESCE(d.finished_at, d.updated_at, a.created_at) ASC",
};

/** Whatever the caller asked for, as a sort this module will actually run. */
export function sortOf(value: unknown): AppSort {
  return value === "name" || value === "oldest" ? value : "deployed";
}

export async function listOwnedApps(ownerId: string, sort: AppSort = "deployed"): Promise<OwnedApp[]> {
  if (!ownerId) return [];
  let r;
  try {
    r = await getPool(DB).query(OWNED_APPS(ORDER[sort] ?? BY_LAST_DEPLOY), [ownerId]);
  } catch (e) {
    if (!/column .*(finished_at|updated_at).* does not exist/i.test(e instanceof Error ? e.message : String(e))) throw e;
    r = await getPool(DB).query(OWNED_APPS("a.created_at DESC"), [ownerId]);
  }
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
    error: row.status === "failed" ? (row.error ?? undefined) : undefined,
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

/** The owner's analytics switch. Off stops the injection and the reads, both. */
export async function setAnalyticsEnabled(slug: string, enabled: boolean): Promise<void> {
  await getPool(DB).query(`UPDATE apps SET analytics_enabled = $2 WHERE slug = $1`, [slug, enabled]);
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
