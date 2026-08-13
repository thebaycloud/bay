import { slugForName } from "./deploys";
import { spawn } from "node:child_process";
import { randomSlug } from "./slug";
import { accessToken as restAccessToken, describeServiceRest, listServicesRest, invalidateToken } from "./gcp-rest";
import { ASSETS_BUCKET } from "./static-release";
import { dbNameForSlug, getPool } from "./db";
import { deleteAppSecrets } from "./app-secrets";
import { dropAppDatabase } from "./pg-role";
import { runIdsForSlug } from "./deploy-runs";
import { appPingScheduleArgs } from "./process-deploy";
import { SCHEDULER_SA } from "./identities";
import { appLogFilter } from "./log-filter";

const PROJECT = "supersonic-deploy-prod";
// The one shared Cloud SQL instance every app's database lives on.
const PG_INSTANCE = "supersonic-shared-pg";
const DEPLOY_JOB_NAME = process.env.DEPLOY_JOB_NAME || "supersonic-deploy-job";
const REGION = "us-central1";
const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH ?? ""}`, CLOUDSDK_CORE_DISABLE_PROMPTS: "1" } as NodeJS.ProcessEnv;

function capture(args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const p = spawn("gcloud", args, { env: ENV });
    let o = "", e = "";
    p.stdout.on("data", (d: Buffer) => (o += d));
    p.stderr.on("data", (d: Buffer) => (e += d));
    p.on("error", rej);
    p.on("close", (c) => (c === 0 ? res(o) : rej(new Error(e.trim() || `gcloud exited ${c}`))));
  });
}

export interface AppSummary {
  slug: string;
  name: string;
  url: string;
  ready: boolean;
  region: string;
  image: string;
  owner: string;
}

const OWNER_LABEL = "supersonic-owner";
const NAME_LABEL = "supersonic-name";

export interface ServiceInfo {
  slug: string;
  name: string;
  url: string;
  ready: boolean;
  region: string;
  created: string;
  revision: string;
  image: string;
  envKeys: string[];
  cloudsql: string;
  repo: string;
  storageBucket: string;
  owner: string;
  /**
   * The app's worker pools, and whether each is running.
   *
   * Everything else here describes a Cloud Run SERVICE, which is what an app was
   * assumed to be. A worker-only app has none — a Telegram bot has no URL, no
   * revision and no request to be ready for — so the dashboard read it as DOWN
   * while the worker was running perfectly, and offered it "Handles anything from
   * 1 to millions of visitors" as a feature.
   */
  workers?: { name: string; ready: boolean }[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Every Cloud Run service in the region, over REST when that works and over
 * gcloud when it does not. Both produce the same Knative shape — REST wraps it
 * in `{ items: [...] }`, which listServicesRest already unwraps — so callers
 * cannot tell which one answered.
 */
async function serviceList(): Promise<any[]> {
  const rest = await listServicesRest();
  if (rest) return rest;
  return JSON.parse(await capture(["run", "services", "list", "--region", REGION, "--project", PROJECT, "--format=json"])) as any[];
}

/** One service, REST first, gcloud second. Same shape either way. */
async function serviceResource(slug: string): Promise<any> {
  const rest = await describeServiceRest(slug);
  if (rest) return rest;
  return JSON.parse(await capture(["run", "services", "describe", slug, "--region", REGION, "--project", PROJECT, "--format=json"]));
}

export async function listServices(ownerId?: string): Promise<AppSummary[]> {
  const arr = await serviceList();
  return arr
    .filter((s) => !ownerId || s.metadata?.labels?.[OWNER_LABEL] === ownerId)
    .map((s) => ({
      slug: s.metadata?.name ?? "",
      name: s.metadata?.labels?.[NAME_LABEL] || s.metadata?.name || "",
      url: s.status?.url ?? "",
      ready: (s.status?.conditions ?? []).find((c: any) => c.type === "Ready")?.status === "True",
      region: REGION,
      image: s.spec?.template?.spec?.containers?.[0]?.image ?? "",
      owner: s.metadata?.labels?.[OWNER_LABEL] ?? "",
    }));
}

export async function ownsApp(slug: string, ownerId: string): Promise<boolean> {
  if (!ownerId) return false;
  try { return (await describeService(slug)).owner === ownerId; } catch { return false; }
}

/**
 * The revision taking the most traffic, or null when the split says nothing.
 *
 * Cloud Run reports traffic as a list of shares; a normal service has one entry at
 * 100%, and a tagged revision can sit in the list with no percent at all.
 */
function servingRevision(s: any): string | null {
  const traffic = (s.status?.traffic ?? []) as Array<{ revisionName?: string; percent?: number }>;
  const best = traffic
    .filter((t) => t.revisionName && (t.percent ?? 0) > 0)
    .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0];
  return best?.revisionName ?? null;
}

/**
 * The app's worker pools, by label.
 *
 * Best-effort: an app with no workers is the common case and a listing failure
 * must not take the dashboard down with it. Empty means "none found", which for
 * an app that has a web service is also simply true.
 */
export async function listWorkers(slug: string): Promise<{ name: string; ready: boolean }[]> {
  try {
    const out = await capture(["beta", "run", "worker-pools", "list", "--region", REGION, "--project", PROJECT,
      "--filter", `metadata.labels.supersonic-parent=${slug}`, "--format=json"]);
    return (JSON.parse(out) as any[]).map((w) => ({
      name: w.metadata?.name ?? "",
      ready: (w.status?.conditions ?? []).find((c: any) => c.type === "Ready")?.status === "True",
    })).filter((w) => w.name);
  } catch {
    return [];
  }
}

/**
 * Cloud Run's answer, remembered for a moment.
 *
 * The cockpit re-asks on every navigation, and clicking into an app and back
 * paid the full round trip each time. Short on purpose: a deploy changes the
 * revision, and this must never be the reason someone watches a stale one.
 * Writers bypass it — see `describeService(slug, { fresh: true })`.
 */
const described = new Map<string, { at: number; info: ServiceInfo }>();
const DESCRIBE_TTL_MS = 20_000;

/**
 * One Cloud Run service, as this product understands it.
 *
 * `workers` is NOT fetched here any more. It used to be, and it cost every
 * caller 1.5–1.7s: `listWorkers` shells out to `gcloud beta run worker-pools
 * list`, a subprocess that on nearly every app returns nothing. The app page
 * awaited it before it could render a single pixel. It is now asked for
 * explicitly, by the one screen that shows it, after that screen exists.
 */
export async function describeService(
  slug: string,
  opts: { withWorkers?: boolean; fresh?: boolean } = {},
): Promise<ServiceInfo> {
  const hit = described.get(slug);
  if (!opts.fresh && !opts.withWorkers && hit && Date.now() - hit.at < DESCRIBE_TTL_MS) return hit.info;
  const info = await describeServiceUncached(slug, opts.withWorkers === true);
  described.set(slug, { at: Date.now(), info });
  return info;
}

async function describeServiceUncached(slug: string, withWorkers: boolean): Promise<ServiceInfo> {
  const s = await serviceResource(slug);
  const c = s.spec?.template?.spec?.containers?.[0] ?? {};
  const ann = s.spec?.template?.metadata?.annotations ?? {};
  return {
    slug: s.metadata?.name ?? slug,
    name: s.metadata?.labels?.[NAME_LABEL] || (s.metadata?.name ?? slug),
    url: s.status?.url ?? "",
    ready: (s.status?.conditions ?? []).find((x: any) => x.type === "Ready")?.status === "True",
    region: REGION,
    created: s.metadata?.creationTimestamp ?? "",
    // The revision actually SERVING, not the newest one that happens to be ready.
    // Those differ after a rollback, and reporting the newest made a successful
    // rollback look like it did nothing: the CLI said "now serving <old>" and the
    // next `status` printed the revision we had just rolled away from.
    revision: servingRevision(s) ?? s.status?.latestReadyRevisionName ?? s.status?.latestCreatedRevisionName ?? "",
    image: c.image ?? "",
    envKeys: (c.env ?? []).map((e: any) => e.name).filter((n: string) => n && n !== "SUPERSONIC_REPO"),
    cloudsql: ann["run.googleapis.com/cloudsql-instances"] ?? "",
    repo: (c.env ?? []).find((e: any) => e.name === "SUPERSONIC_REPO")?.value ?? "",
    storageBucket: (c.env ?? []).find((e: any) => e.name === "STORAGE_BUCKET")?.value ?? "",
    owner: s.metadata?.labels?.[OWNER_LABEL] ?? "",
    workers: withWorkers ? await listWorkers(slug) : undefined,
  };
}

/**
 * An app's bucket name.
 *
 * The same rule as `bucketName` in lib/deploy-pipeline.ts, and that is one copy
 * too many — a name that decides whether a bucket is FOUND in one place and
 * CREATED in another has to be one function. Left here for now because unifying
 * it crosses a module boundary the deploy path owns; it is on the list.
 */
export function bucketForSlug(slug: string): string {
  return `supersonicdeploy-${slug}`.slice(0, 63);
}

/** Resolve the Cloud Run service name for a deploy: reuse the user's existing app
 * with this friendly name (so redeploys update in place), otherwise a fresh short
 * random slug that isn't already taken. */
export async function resolveSlug(ownerId: string, friendlyName: string): Promise<string> {
  // Ask the deploy record first. Cloud Run labels only describe apps that own a Cloud
  // Run service, and static apps do not — they share one. Relying on labels alone meant
  // every static redeploy minted a fresh slug and created a second app beside the first.
  const known = await slugForName(ownerId, friendlyName);
  if (known) return known;

  const taken = new Set<string>();
  let existing: string | null = null;
  try {
    const arr = await serviceList();
    for (const s of arr) {
      const nm = s.metadata?.name as string | undefined;
      if (nm) taken.add(nm);
      if (ownerId && s.metadata?.labels?.[OWNER_LABEL] === ownerId && s.metadata?.labels?.[NAME_LABEL] === friendlyName) existing = nm ?? null;
    }
  } catch { /* listing failed — hand back a fresh random slug */ }
  if (existing) return existing;

  // Also what the REGISTRY remembers.
  //
  // The taken-set was live Cloud Run services alone, so a slug freed by a delete
  // was immediately re-issuable — which this file already states the consequence
  // of, about databases: "the slug space is five characters, so a name WILL
  // eventually be reused, and the new app would have inherited a stranger's
  // tables". `deleteApp` now removes the images too, so this is belt and braces
  // for the case that matters most: a delete that half-failed leaves
  // `<slug>-cache` behind, buildkit reads it through `--cache-from` before it
  // builds anything, and the new tenant's first build starts from a stranger's
  // layers.
  //
  // Best-effort, and deliberately after the live-service check: an unreachable
  // registry must narrow the choice of names, never fail the deploy.
  try {
    const packages = await capture(["artifacts", "packages", "list",
      "--repository", IMAGE_REPO, "--location", REGION, "--project", PROJECT, "--format=value(name)"]);
    for (const line of packages.split("\n")) {
      const pkg = line.trim().split("/").pop();
      if (pkg) taken.add(pkg.replace(/-cache$/, ""));
    }
  } catch { /* registry unreachable — the live-service set still applies */ }

  let slug = randomSlug();
  for (let i = 0; taken.has(slug) && i < 10; i++) slug = randomSlug();
  return slug;
}

/**
 * An access token, from the in-memory cache in lib/gcp-rest (metadata server on
 * Cloud Run, gcloud locally). The gcloud spawn stays as the last resort so this
 * cannot become a new failure mode.
 */
async function accessToken(): Promise<string> {
  const t = await restAccessToken();
  if (t) return t;
  return (await capture(["auth", "print-access-token"])).trim();
}

export async function listBucketObjects(bucket: string): Promise<{ name: string; size: number; updated: string; contentType: string }[]> {
  const t = await accessToken();
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${bucket}/o?maxResults=200`, {
    headers: { Authorization: "Bearer " + t, "x-goog-user-project": PROJECT },
  });
  // This is the one consumer of the shared token cache that talks to GCS
  // directly instead of through gcp-rest's `authed()`, so nothing was dropping a
  // token the server had already rejected. A credential revoked or rotated
  // before its cached expiry would then be re-served to every retry inside the
  // window, turning the dashboard's Storage tab into a stuck "Invalid
  // Credentials". Dropping it here means the next call mints a fresh one.
  if (r.status === 401 || r.status === 403) invalidateToken();
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return (j.items ?? []).map((o: { name: string; size?: string; updated: string; contentType?: string }) => ({
    name: o.name, size: Number(o.size ?? 0), updated: o.updated, contentType: o.contentType ?? "",
  }));
}

export interface Job { id: string; label: string; schedule: string; uri: string; state: string; lastAttempt: string; }

export async function listJobs(slug: string): Promise<Job[]> {
  const out = await capture(["scheduler", "jobs", "list", "--location", REGION, "--project", PROJECT, "--format=json"]);
  const arr = JSON.parse(out) as any[];
  const prefix = `${slug}--`;
  return arr
    .map((j) => ({ id: (j.name || "").split("/").pop() as string, raw: j }))
    .filter((x) => x.id.startsWith(prefix))
    .map((x) => ({
      id: x.id,
      label: x.id.replace(prefix, ""),
      schedule: x.raw.schedule || "",
      uri: x.raw.httpTarget?.uri || "",
      state: x.raw.state || "",
      lastAttempt: x.raw.lastAttemptTime || "",
    }));
}

async function retryMutate<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (i < tries - 1 && /ABORTED|sync mutate|cannot be queued/i.test(m)) {
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }
      throw e;
    }
  }
}

/**
 * A cron the dashboard created: a scheduled, authenticated request at the app.
 *
 * It takes the service url and a path rather than the joined uri because the
 * request and the token it carries have to describe the same service — see
 * `appPingScheduleArgs`, which owns that rule and is tested against it.
 */
export async function createJob(slug: string, name: string, schedule: string, serviceUrl: string, path: string): Promise<string> {
  const id = `${slug}--${name}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 60);
  const argv = appPingScheduleArgs({
    id, schedule, serviceUrl, path,
    region: REGION, project: PROJECT, schedulerServiceAccount: SCHEDULER_SA,
  });
  await retryMutate(() => capture(argv));
  return id;
}

export async function deleteJob(id: string): Promise<void> {
  await retryMutate(() => capture(["scheduler", "jobs", "delete", id, "--location", REGION, "--project", PROJECT, "--quiet"]));
}

export async function runJob(id: string): Promise<void> {
  await retryMutate(() => capture(["scheduler", "jobs", "run", id, "--location", REGION, "--project", PROJECT]));
}

export interface AppError { message: string; time: string; }

export async function getErrors(slug: string): Promise<AppError[]> {
  const filter = appLogFilter(slug, { minSeverity: "ERROR" });
  try {
    const out = await capture(["logging", "read", filter, "--project", PROJECT, "--limit", "15", "--freshness", "7d", "--format=json"]);
    const arr = JSON.parse(out) as any[];
    return arr
      .map((e) => ({
        message: String(e.textPayload ?? e.jsonPayload?.message ?? (e.jsonPayload ? JSON.stringify(e.jsonPayload) : "")).replace(/\s+/g, " ").trim().slice(0, 400),
        time: e.timestamp ?? "",
      }))
      .filter((e) => e.message);
  } catch {
    return [];
  }
}

export interface LogLine { message: string; time: string; severity: string; }

/** General log read (all severities by default) for the app's Cloud Run service. */
export async function getLogs(
  slug: string,
  opts: { limit?: number; severity?: string; freshness?: string } = {}
): Promise<LogLine[]> {
  const filter = appLogFilter(slug, opts.severity ? { minSeverity: opts.severity } : {});
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const out = await capture([
    "logging", "read", filter,
    "--project", PROJECT, "--limit", String(limit),
    "--freshness", opts.freshness ?? "1h", "--format=json",
  ]);
  const arr = JSON.parse(out) as any[];
  return arr
    .map((e) => ({
      message: String(e.textPayload ?? e.jsonPayload?.message ?? (e.jsonPayload ? JSON.stringify(e.jsonPayload) : "")).replace(/\s+/g, " ").trim().slice(0, 600),
      time: e.timestamp ?? "",
      severity: e.severity ?? "DEFAULT",
    }))
    .filter((e) => e.message)
    .reverse(); // oldest first, natural reading order
}

/** Set and/or unset environment variables on the app, triggering a new revision. */
export async function setEnv(slug: string, set: Record<string, string>, unset: string[] = []): Promise<void> {
  const args = ["run", "services", "update", slug, "--region", REGION, "--project", PROJECT];
  const entries = Object.entries(set).filter(([k]) => k);
  if (entries.length) args.push(`--update-env-vars=^~~^${entries.map(([k, v]) => `${k}=${v}`).join("~~")}`);
  if (unset.length) args.push(`--remove-env-vars=${unset.join(",")}`);
  if (!entries.length && !unset.length) return;
  await capture(args);
}

/** `ready` is whether the revision ever started — a failed deploy leaves one that never did. */
export interface Revision { name: string; created: string; active: boolean; ready: boolean; }

export async function listRevisions(slug: string): Promise<Revision[]> {
  const out = await capture(["run", "revisions", "list", "--service", slug, "--region", REGION, "--project", PROJECT, "--format=json"]);
  const arr = JSON.parse(out) as any[];
  return arr
    .map((r) => ({
      name: r.metadata?.name ?? "",
      created: r.metadata?.creationTimestamp ?? "",
      active: (r.status?.conditions ?? []).some((c: any) => c.type === "Active" && c.status === "True"),
      ready: (r.status?.conditions ?? []).some((c: any) => c.type === "Ready" && c.status === "True"),
    }))
    .sort((a, b) => (a.created < b.created ? 1 : -1));
}

/*
 * WAS: `rollback` — `gcloud run revisions list` and a traffic split back to the
 * last Ready revision. It went with the container lane that produced those
 * revisions. Rolling back is now one write to `apps.desired_release`, which the
 * reconciler converges on through the same function a deploy uses; see
 * lib/rollback.ts.
 */

/**
 * Permanently delete an app and everything a deploy of it created.
 *
 * "Everything" is the hard part, and this used to get four of nine. The rest —
 * the prepared code bundles, the dependency cache, the thumbnail, and the app's
 * own Postgres database — kept accumulating in shared infrastructure under the
 * name of an app that no longer existed, and had to be swept by hand. The
 * database is the one that actually bites: the slug space is five characters, so
 * a name WILL eventually be reused, and the new app would have inherited a
 * stranger's tables.
 *
 * Every step is best-effort and independent: most apps have never had most of
 * these, and a missing piece must never stop the rest from being cleaned up.
 */
/** The one Artifact Registry repository every app's image is pushed to. */
export const IMAGE_REPO = "cloud-run-source-deploy";

/**
 * Which package names in the registry belong to this app.
 *
 * Prefix-matched on purpose rather than assumed: an app owns `<slug>`,
 * `<slug>-cache`, and one pair per sibling (`<slug>-api`, `<slug>-api-cache`),
 * and listing is the only way to know which siblings ever existed — the config
 * that named them is gone by the time anything deletes the app.
 *
 * Anchored with the boundary check so `<slug>` never matches a longer slug that
 * merely starts with the same five characters. The slug space is small; treating
 * `ab12x` as a prefix of `ab12xy` would delete a live app's images.
 */
export async function appPackages(slug: string): Promise<string[]> {
  try {
    const out = await capture(["artifacts", "packages", "list",
      "--repository", IMAGE_REPO, "--location", REGION, "--project", PROJECT, "--format=value(name)"]);
    return out.split("\n").map((l) => l.trim().split("/").pop() ?? "").filter(Boolean)
      .filter((p) => p === slug || p.startsWith(`${slug}-`));
  } catch {
    return [];   // nothing to clean, or the registry is unreachable — never a reason to fail a delete
  }
}

/**
 * Which of these resource names belong to THIS app.
 *
 * A multi-service app's resources are named `<slug>-<something>`: `foo-api`,
 * `foo-worker`, `foo-bot`, `foo-nightly`. So a prefix match is how they are
 * found — and a prefix match alone is also how another APP gets deleted, because
 * an app's slug may itself begin with this slug plus a hyphen. `slugify`
 * collapses runs of hyphens but permits single ones, so `subio` and `subio-2`
 * can both exist, and on 5 Aug 2026 both did, both live: deleting the first
 * would have taken the second's Cloud Run service with it, silently.
 *
 * The rule that fixes it is the one a human would apply by eye: a name that IS
 * another app's slug belongs to that app, whatever it starts with. Anything
 * beginning `<slug>-<something>` where `<slug>-<something>` is not itself an
 * app is this app's.
 *
 * `others` is passed in rather than queried here so the decision is pure and can
 * be tested without a database — which is the whole reason this is a function
 * and not four inline filters.
 */
export function ownedResourceNames(slug: string, names: string[], others: Set<string>): string[] {
  return names
    .map((n) => n.trim())
    .filter((n) => n && n !== slug && n.startsWith(`${slug}-`) && !others.has(n));
}

/** Every other app's slug, for the check above. Empty on failure, which makes
 * the filter fall back to prefix-only rather than deleting nothing at all — the
 * pre-existing behaviour, not a new way to fail. */
async function otherAppSlugs(slug: string): Promise<Set<string>> {
  try {
    const r = await getPool("supersonic_platform").query(`SELECT slug FROM apps WHERE slug <> $1`, [slug]);
    return new Set(r.rows.map((row) => row.slug as string));
  } catch {
    return new Set();
  }
}

/**
 * Delete ONLY the Cloud Run service, leaving everything else the app owns.
 *
 * Not `deleteApp`: the database, the secrets, the images, the buckets and the
 * fleet placement all stay. This exists for one transition Cloud Run does not
 * otherwise offer — a live service whose container is unnamed cannot be
 * redeployed with named containers, which a Cloud SQL sidecar requires — so the
 * service is recreated by the very next command. See `needsServiceRecreate`.
 */
export async function deleteRunService(slug: string): Promise<void> {
  await capture(["run", "services", "delete", slug, "--region", REGION, "--project", PROJECT, "--quiet"]);
}

export async function deleteApp(slug: string): Promise<void> {
  // Two serving lanes, either of which may be absent:
  //  - container: its own Cloud Run service + optional per-app bucket
  //  - static: no service — its bytes live under <slug>/ in the shared assets
  //    bucket. `run services delete` MUST be optional here, or deleting a static
  //    app throws "service not found" and fails the whole delete.
  try { await capture(["run", "services", "delete", slug, "--region", REGION, "--project", PROJECT, "--quiet"]); } catch { /* static: no per-app service */ }
  // Sibling services from a multi-service app (`<slug>-api`, `<slug>-worker`).
  // Deleting only the primary would leave them running and billing under the name
  // of an app that no longer exists, reachable by nothing.
  //
  // Filtered through `ownedResourceNames`, and that is not tidiness. A bare
  // `startsWith(slug + "-")` also matches the resources of any app whose SLUG
  // begins with this one plus a hyphen, and that is not hypothetical: on 5 Aug
  // the platform held both `subio` and `subio-2`, live, and deleting the first
  // would have taken the second's Cloud Run service with it — a different app,
  // no warning, no record.
  const others = await otherAppSlugs(slug);
  try {
    const all = await capture(["run", "services", "list", "--region", REGION, "--project", PROJECT, "--format=value(metadata.name)"]);
    for (const name of ownedResourceNames(slug, all.split("\n"), others)) {
      await capture(["run", "services", "delete", name, "--region", REGION, "--project", PROJECT, "--quiet"]).catch(() => {});
    }
  } catch { /* listing failed — the primary is already gone */ }

  // Cloud Run WORKER POOLS. Nothing deleted these, ever.
  //
  // A worker-only app — a bot, a queue consumer — has no service and no job: its
  // process runs in a worker pool named `<slug>-<process>`, which neither
  // `run services list` nor `run jobs list` shows. So deleting such an app left
  // a container RUNNING and billing, permanently, with no row anywhere to
  // explain it and no surface that would ever show it again. Measured: deleting
  // a worker-only test app left `lleb7-bot` alive.
  try {
    const pools = await capture(["beta", "run", "worker-pools", "list", "--region", REGION, "--project", PROJECT, "--format=value(metadata.name)"]);
    for (const name of ownedResourceNames(slug, pools.split("\n"), others)) {
      await capture(["beta", "run", "worker-pools", "delete", name, "--region", REGION, "--project", PROJECT, "--quiet"]).catch(() => {});
    }
  } catch { /* no worker pools, or the command is unavailable */ }

  // Cloud Run JOBS: the release job, each cron's job, and the one-off `exec`
  // job. Left behind they hold configuration and image references for an app
  // that no longer exists, and the slug space is small enough that the name is
  // eventually handed to somebody else.
  try {
    const jobs = await capture(["run", "jobs", "list", "--region", REGION, "--project", PROJECT, "--format=value(metadata.name)"]);
    const mine = ownedResourceNames(slug, jobs.split("\n"), others).concat(
      jobs.split("\n").map((l) => l.trim()).filter((n) => n === `ss-exec-${slug}`),
    );
    for (const name of new Set(mine)) {
      await capture(["run", "jobs", "delete", name, "--region", REGION, "--project", PROJECT, "--quiet"]).catch(() => {});
    }
  } catch { /* no jobs */ }

  // Cloud SCHEDULER jobs — the ones that actually keep firing.
  //
  // The worst of the three to leave behind: a cron whose app is gone goes on
  // waking up on its schedule forever, against a URL that answers 404, writing
  // a failure into the project's logs every time. Measured: deleting an app
  // with a `*/10 * * * *` cron left `<slug>-nightly` scheduled and armed.
  try {
    const sched = await capture(["scheduler", "jobs", "list", "--location", REGION, "--project", PROJECT, "--format=value(name)"]);
    // `jobs list` prints fully-qualified names; the last path element is the id.
    const ids = sched.split("\n").map((l) => l.trim().split("/").pop() ?? "");
    for (const name of ownedResourceNames(slug, ids, others)) {
      await capture(["scheduler", "jobs", "delete", name, "--location", REGION, "--project", PROJECT, "--quiet"]).catch(() => {});
    }
  } catch { /* no schedules */ }
  try { await capture(["beta", "run", "domain-mappings", "delete", "--domain", `${slug}.supersonic.cv`, "--region", REGION, "--project", PROJECT, "--quiet"]); } catch { /* no mapping */ }
  try { await capture(["storage", "rm", "-r", `gs://supersonicdeploy-${slug}`, "--quiet"]); } catch { /* no per-app bucket */ }
  try { await capture(["storage", "rm", "-r", `gs://${ASSETS_BUCKET}/${slug}`, "--quiet"]); } catch { /* not a static release */ }

  // What the runner lane leaves in the shared assets bucket: the prepared
  // bundles it serves from, and the cross-deploy dependency cache.
  try { await capture(["storage", "rm", "-r", `gs://${ASSETS_BUCKET}/ready/${slug}`, "--quiet"]); } catch { /* never ran on the runner */ }
  try { await capture(["storage", "rm", `gs://${ASSETS_BUCKET}/cache/${slug}.tgz`, "--quiet"]); } catch { /* no build cache */ }
  try { await capture(["storage", "rm", `gs://${ASSETS_BUCKET}/_thumbs/${slug}.jpg`, "--quiet"]); } catch { /* no thumbnail */ }

  // The app's database on the shared instance. Left behind, these accumulate
  // silently until a five-character slug is reused and the new app finds
  // somebody else's tables already in it.
  //
  // This call DOES NOT WORK for a provisioned database and never has, and the
  // catch is why nobody knew. Measured on 5 Aug:
  //
  //   ERROR: (gcloud.sql.databases.delete) HTTPError 400: Invalid request:
  //   failed to delete database "icflz". Detail: pq: must be owner of database
  //   icflz. (Please use psql client to delete database that is not owned by
  //   "cloudsqlsuperuser")
  //
  // Provisioning gives each app its own role and makes that role the owner —
  // which is the isolation the deploy log advertises, "no other app can reach
  // it" — and gcloud connects as cloudsqlsuperuser, which is not it. So every
  // delete since databases existed has left the customer's data on the
  // instance. Five such databases were on it when this was written.
  //
  // Done over SQL rather than through the API, which is the only way it can be
  // done at all: taking membership of the app's role, then ownership of the
  // database, then dropping it. `dropStatements` documents why each step is
  // required by the one after it. The gcloud call is gone rather than kept as a
  // first attempt — it cannot succeed for any database this platform
  // provisioned, and a failing call ahead of a working one is just a confusing
  // line in the log.
  //
  // Watched running once, on 5 Aug, against `icflz` — the oldest of the five
  // orphans, and ours.
  const dbName = dbNameForSlug(slug);
  try {
    const { dropped, reason } = await dropAppDatabase(slug, dbName, (l) => console.error(`deleteApp ${slug}: ${l}`));
    if (!dropped) {
      // A customer's data staying on a shared instance after they asked for it
      // to be gone. The old code's silent catch is exactly how that went
      // unnoticed for as long as databases have existed.
      console.error(`deleteApp ${slug}: database ${dbName} NOT deleted — ${reason ?? "unknown"}`);
    }
  } catch (e) {
    console.error(`deleteApp ${slug}: database ${dbName} NOT deleted — ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
  }

  // The app's secrets. Left behind they are live credentials belonging to an app
  // that no longer exists, and the slug space is small enough that the name will
  // eventually be handed to somebody else.
  await deleteAppSecrets(slug);

  // Its images, and its layer cache.
  //
  // Nothing deleted these, ever. This function's own docstring claims it removes
  // "everything a deploy of it created" and it enumerated eleven things, none of
  // them in Artifact Registry — invisible while only a Dockerfile-shipping repo
  // reached that path, and now true of every app.
  //
  // Two reasons it is not merely untidy. Storage grows with DEPLOYS rather than
  // apps: each one pushes a full image plus a `mode=max` cache, which by
  // construction holds MORE layers than the image, and every repair retry pushes
  // another. And a deleted app's complete source stays readable forever.
  //
  // Sharper still, it is the slug-reuse hazard. `randomSlug` is one letter and
  // four alphanumerics and `resolveSlug` builds its taken-set from LIVE services,
  // so a freed slug is immediately re-issuable — this file already says so about
  // databases: "the slug space is five characters, so a name WILL eventually be
  // reused, and the new app would have inherited a stranger's tables". The image
  // path derives from that same slug. A new tenant would inherit `<slug>:latest`
  // and, more sharply, `<slug>-cache`, which buildkit reads through
  // `--cache-from` BEFORE it builds anything.
  //
  // Sibling packages go too: a sibling's image is named for the service, which is
  // `<slug>-<label>`, so they share the prefix by construction.
  for (const pkg of await appPackages(slug)) {
    await capture(["artifacts", "packages", "delete", pkg,
      "--repository", IMAGE_REPO, "--location", REGION, "--project", PROJECT, "--quiet"]).catch(() => {});
  }

  // And any deploy still running for it.
  //
  // Deploys were moved into a Cloud Run Job precisely so they survive the client
  // that started them — which also means deleting an app does not stop one. A job
  // orphaned this way keeps going against infrastructure that has just been torn
  // down: it burns repair-agent tokens on failures it can no longer fix, and it
  // can RECREATE the Cloud Run service after the delete has removed it. Observed
  // running thirty minutes past the deletion of its own app.
  await cancelDeploysFor(slug);
}

/**
 * Cancel any job execution currently deploying this slug.
 *
 * Executions are matched by the run id in their arguments, so this asks the
 * deploy_runs table which runs belong to the app and cancels the executions
 * carrying those ids. Best-effort throughout: a deploy that cannot be cancelled
 * must not stop the app from being deleted.
 */
export async function cancelDeploysFor(slug: string): Promise<void> {
  try {
    const runIds = await runIdsForSlug(slug);
    if (!runIds.length) return;
    const out = await capture(["run", "jobs", "executions", "list",
      "--job", DEPLOY_JOB_NAME, "--region", REGION, "--project", PROJECT,
      "--filter", "status.runningCount>0", "--format=value(metadata.name)"]);
    for (const name of out.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const args = await capture(["run", "jobs", "executions", "describe", name,
        "--region", REGION, "--project", PROJECT,
        "--format=value(spec.template.spec.containers[0].args)"]).catch(() => "");
      if (!runIds.some((id: string) => args.includes(id))) continue;
      await capture(["run", "jobs", "executions", "cancel", name,
        "--region", REGION, "--project", PROJECT, "--quiet"]).catch(() => {});
    }
  } catch { /* nothing running, or listing failed */ }
}

const DEPLOYER_SA = "supersonic-deployer@supersonic-deploy-prod.iam.gserviceaccount.com";

// Cloud Run has no exec-into-a-running-instance. So we run the command in a
// one-off Cloud Run Job built from the app's own image + env + Cloud SQL — an
// isolated instance that can't affect the serving app. The command is passed
// base64-encoded via an env var so no shell-escaping games are needed.
export async function execCommand(slug: string, command: string): Promise<{ output: string; exitCode: number }> {
  const s = await serviceResource(slug);
  const c = s.spec?.template?.spec?.containers?.[0] ?? {};
  const image = c.image as string;
  if (!image) throw new Error("could not resolve the app's container image");
  const cloudsql = s.spec?.template?.metadata?.annotations?.["run.googleapis.com/cloudsql-instances"] ?? "";
  const envPairs: string[] = (c.env ?? [])
    .filter((e: any) => typeof e.value === "string" && e.name)
    .map((e: any) => `${e.name}=${e.value}`);
  envPairs.push(`SS_CMD=${Buffer.from(command).toString("base64")}`);

  const jobName = `ss-exec-${slug}`.replace(/[^a-z0-9-]/g, "-").slice(0, 63);
  const deploy = [
    "run", "jobs", "deploy", jobName,
    "--image", image,
    "--region", REGION, "--project", PROJECT,
    "--service-account", DEPLOYER_SA,
    "--command", "/bin/sh",
    `--args=^@@^-c@@echo "$SS_CMD" | base64 -d | sh`,
    `--set-env-vars=^~~^${envPairs.join("~~")}`,
    "--max-retries", "0",
    "--task-timeout", "240s",
  ];
  if (cloudsql) deploy.push(`--set-cloudsql-instances=${cloudsql}`);
  await capture(deploy);

  let failed = false;
  try {
    await capture(["run", "jobs", "execute", jobName, "--region", REGION, "--project", PROJECT, "--wait"]);
  } catch {
    failed = true; // the command exited non-zero (or the task failed) — still return its output
  }

  // Precise: pull logs for the execution we just ran.
  let execName = "";
  try {
    execName = (await capture(["run", "jobs", "executions", "list", "--job", jobName, "--region", REGION, "--project", PROJECT, "--limit", "1", "--format=value(metadata.name)"])).trim();
  } catch { /* fall back to job-scoped logs */ }

  // Cloud Logging ingestion lags the job's completion: `--wait` returns as soon
  // as the task ends, but container stdout can land a few seconds later (the
  // exit-marker event arrives on a faster path). Poll until real output shows.
  const isMarker = (l: string) => /^Container called exit\(\d+\)\.?$/.test(l.trim());
  let lines: string[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 0 ? 3500 : 2500));
    lines = await execLogs(jobName, execName);
    if (lines.some((l) => !isMarker(l))) break; // got real (non-marker) output
  }

  // The "Container called exit(N)." line carries the real exit code and is
  // noise in the output, so parse it out then drop it.
  let exitCode = failed ? 1 : 0;
  const clean: string[] = [];
  for (const l of lines) {
    const m = /^Container called exit\((\d+)\)\.?$/.exec(l.trim());
    if (m) { exitCode = Number(m[1]); continue; }
    clean.push(l);
  }
  return { output: clean.join("\n"), exitCode };
}

async function execLogs(jobName: string, execName: string): Promise<string[]> {
  const parts = [`resource.type=cloud_run_job`, `resource.labels.job_name=${jobName}`];
  if (execName) parts.push(`labels."run.googleapis.com/execution_name"=${execName}`);
  try {
    const out = await capture(["logging", "read", parts.join(" AND "), "--project", PROJECT, "--limit", "300", "--freshness", "10m", "--format=json"]);
    const arr = JSON.parse(out) as any[];
    return arr
      .map((e) => String(e.textPayload ?? (e.jsonPayload ? JSON.stringify(e.jsonPayload) : "")))
      .filter((l) => l.trim())
      .reverse(); // oldest first
  } catch {
    return [];
  }
}
