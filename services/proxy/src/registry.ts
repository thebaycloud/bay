import { createHash } from "node:crypto";
import { db } from "./db";
import { parseRoutes, type Route } from "./routes";

export interface AppRow {
  id: string;
  slug: string;
  workspace_id: string;
  owner_id: string;
  owner_email: string;
  /**
   * The owner's plan and subscription status, carried so the response path can
   * decide the badge without a control-plane call on every HTML page. See
   * `plan.ts`.
   *
   * Nullable because `users.status` is nullable in the schema — it was added
   * after the fact by 007 and only backfilled for rows that existed then.
   * `badgeRequired` reads null as free and shows the badge, which is both the
   * safe default and what the proxy did before plans existed.
   */
  owner_plan: string | null;
  owner_status: string | null;
  run_url: string | null;
  visibility: "private" | "shared" | "workspace" | "public";
  status: "deploying" | "live" | "failed";
  /** The latest deploy record, so the edge can tell "still building" from "died". */
  deploy: { status: string; error: string | null; updatedAt: number | null } | null;
  /** Path-prefix routes when the app has more than one service. Null for the rest. */
  routes: Route[] | null;
  /** False only for an app that runs no web process — a bot, a queue, a cron. */
  has_web: boolean;
  /**
   * This app's site inside the shared umami instance, or null when it has none.
   *
   * Null is the ordinary state for an app created before analytics existed, one
   * whose provisioning call failed, and one created while umami was down. Every
   * reader treats it as "no analytics for this app" — the tracker is not
   * injected, `/_bay` is not claimed, and the panel says the half is off. There
   * is no branch anywhere that treats it as an error.
   */
  umami_website_id: string | null;
  /** The owner's switch. False stops the injection and the reads, both. */
  analytics_enabled: boolean;
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

/**
 * The last answer the database gave for a slug, with no expiry at all.
 *
 * THE FAILURE THIS EXISTS FOR
 *
 * `cache` above is a freshness cache: an entry past its window is discarded and
 * the next request queries. So a database that cannot answer used to mean every
 * request threw, and `handle`'s outer catch turned that into a 500 — for EVERY
 * app on `*.supersonic.cv` at once, however healthy the nodes holding them were.
 *
 * That is not a hypothetical shape. Railway ran it on 19 May 2026: their edge
 * proxies took routing state from a control-plane API, the API went away, the
 * proxies coasted on cached state, the caches expired, and every region went
 * dark regardless of which cloud its apps were on. A multi-runtime data plane
 * does not survive a single-source control plane, and ours is multi-runtime.
 *
 * The node router has had the right posture all along — it reads `routes.json`
 * off local disk, under a comment saying a control plane that is down must not
 * be able to stop a node serving. The layer in FRONT of everything did not.
 *
 * IN MEMORY, AND THAT IS NOT A SHORTCUT
 *
 * The design calls this a locally durable snapshot, and on a machine with a disk
 * it should be one. This proxy runs on Cloud Run, where the only writable path
 * is a tmpfs that dies with the instance exactly as memory does — so writing it
 * there would add a file, add a code path, and buy nothing. The instance lives
 * for days and the outage being survived lasts minutes to hours, which memory
 * covers completely. When the edge moves onto machines with real disks, the
 * durable half becomes worth writing; until then it would be ceremony.
 */
const known = new Map<string, AppRow | null>();

/**
 * When the database stopped answering, or null while it is.
 *
 * Serving stale state silently is the version of this that lies. `/_healthz`
 * reads this so an edge running on memory is visible from outside rather than
 * looking identical to a healthy one.
 */
let staleSince: number | null = null;
let lastAttempt = 0;
let lastError: Error | null = null;

/**
 * How often to try the database again while it is down.
 *
 * Without a bound, every request during an outage opens a connection to a host
 * that is not answering and waits out the connect timeout — so the edge would
 * serve stale state correctly and slowly, which for a visitor is its own kind of
 * outage. Five seconds is short enough that recovery is noticed within one
 * request of it happening.
 */
const RETRY_WHILE_STALE_MS = 5_000;

/** Test seam. The three module-level maps are the whole of this module's state. */
export function resetRegistry(): void {
  cache.clear();
  known.clear();
  staleSince = null;
  lastAttempt = 0;
  lastError = null;
}

/** How long the edge has been serving from memory, or null if it is not. */
export function registryStaleFor(now: number = Date.now()): number | null {
  return staleSince === null ? null : now - staleSince;
}

export interface RegistryDeps {
  /** One slug's row, or null when there is no such app. Throws when it cannot ask. */
  fetchApp: (slug: string) => Promise<AppRow | null>;
  now: () => number;
  log: (line: string) => void;
}

function remember(slug: string, row: AppRow | null, at: number): void {
  // A Map iterates in insertion order, so the first key is the oldest.
  // Refreshing a key already present replaces it, so nothing needs evicting.
  if (cache.size >= CACHE_MAX && !cache.has(slug)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(slug, { row, at });
  // Bounded for the same reason the cache is, and it is the same reason twice:
  // cache keys come from the Host header, so a stranger walking subdomains owns
  // the key space. Unbounded, the map that exists to survive an outage would be
  // the thing that causes one.
  if (known.size >= CACHE_MAX && !known.has(slug)) {
    const oldest = known.keys().next().value;
    if (oldest !== undefined) known.delete(oldest);
  }
  known.set(slug, row);
}

export async function lookupWith(deps: RegistryDeps, slug: string): Promise<AppRow | null> {
  const now = deps.now();
  const hit = cache.get(slug);
  if (hit && now - hit.at < ttlFor(hit.row)) return hit.row;

  // While the database is down, ask it only occasionally and answer from memory
  // in between. `known.has` rather than a truthiness check: a slug we resolved to
  // NOTHING is a fact we learned, and an app that did not exist a minute ago
  // still does not.
  if (staleSince !== null && now - lastAttempt < RETRY_WHILE_STALE_MS) {
    if (known.has(slug)) return known.get(slug) ?? null;
    throw lastError ?? new Error("the app registry is unavailable");
  }

  lastAttempt = now;
  let row: AppRow | null;
  try {
    row = await deps.fetchApp(slug);
  } catch (e) {
    lastError = e instanceof Error ? e : new Error(String(e));
    if (staleSince === null) {
      staleSince = now;
      // Once per outage, not once per request. An outage that is also a log
      // flood is an outage nobody can read their way out of.
      deps.log(`registry: the database is not answering — serving from the last known state (${lastError.message})`);
    }
    // Only for a slug we have actually resolved. Inventing an answer for one we
    // have never seen would let a stranger walking subdomains decide what this
    // edge serves, and "we do not know" is the honest reply.
    if (known.has(slug)) return known.get(slug) ?? null;
    throw lastError;
  }

  if (staleSince !== null) {
    deps.log(`registry: the database is answering again after ${now - staleSince}ms`);
    staleSince = null;
  }
  remember(slug, row, now);
  return row;
}

async function fetchAppRow(slug: string): Promise<AppRow | null> {
  // The deploys row rides along because apps.status alone cannot distinguish a
  // deploy that is working from one whose process died: both read 'deploying'
  // forever. `deploy_updated_at` is when that deploy last reported progress, and
  // `deploy_error` is the reason a failed one gives.
  const r = await db().query(
    `SELECT a.*, u.email AS owner_email,
            u.plan   AS owner_plan,
            u.status AS owner_status,
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
        // Normalised for the same reason has_web is, and with the opposite
        // default. `SELECT a.*` on a database that has not run 030 yields
        // undefined for both columns, and the edge deploys ahead of migrations.
        // An absent id means no analytics — never "some other app's site" and
        // never a crash — while an absent switch reads as on, which is what the
        // column's own DEFAULT says and what an owner who has never touched it
        // should get once the id arrives.
        umami_website_id: (raw as unknown as { umami_website_id?: string | null }).umami_website_id ?? null,
        analytics_enabled: (raw as unknown as { analytics_enabled?: unknown }).analytics_enabled !== false,
        deploy: raw.deploy_status
          ? {
              status: raw.deploy_status,
              error: raw.deploy_error ?? null,
              updatedAt: raw.deploy_updated_at ? new Date(raw.deploy_updated_at).getTime() : null,
            }
          : null,
      }
    : null;
  return row;
}

/** The real dependencies, for callers that are not tests. */
const liveDeps: RegistryDeps = {
  fetchApp: fetchAppRow,
  now: Date.now,
  log: (l: string) => console.error(l),
};

export function lookupApp(slug: string): Promise<AppRow | null> {
  return lookupWith(liveDeps, slug);
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
