import { slugForName } from "./deploys";
import { spawn } from "node:child_process";
import { randomSlug } from "./slug";
import { accessToken as restAccessToken, describeServiceRest, listServicesRest, invalidateToken } from "./gcp-rest";
import { ASSETS_BUCKET } from "./static-release";

const PROJECT = "supersonic-deploy-prod";
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

export async function describeService(slug: string): Promise<ServiceInfo> {
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
  };
}

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

export async function createJob(slug: string, name: string, schedule: string, uri: string): Promise<string> {
  const id = `${slug}--${name}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 60);
  await retryMutate(() => capture(["scheduler", "jobs", "create", "http", id, "--schedule", schedule, "--uri", uri, "--http-method", "POST", "--location", REGION, "--project", PROJECT]));
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
  const filter = `resource.type=cloud_run_revision AND resource.labels.service_name=${slug} AND severity>=ERROR`;
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
  const parts = [`resource.type=cloud_run_revision`, `resource.labels.service_name=${slug}`];
  if (opts.severity) parts.push(`severity>=${opts.severity.toUpperCase()}`);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const out = await capture([
    "logging", "read", parts.join(" AND "),
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

/**
 * Roll traffic back to the last revision that can actually serve.
 *
 * "The one before" is not good enough: a deploy that failed to start still leaves
 * a revision behind, and Cloud Run refuses to route to it — so rolling back off a
 * repaired app aimed straight at the broken revision it had just replaced and died
 * with a raw gcloud error. Skip anything that never became Ready.
 */
export async function rollback(slug: string): Promise<string> {
  const revs = await listRevisions(slug);
  if (revs.length < 2) throw new Error("no previous revision to roll back to");
  const target = revs.slice(1).find((r) => r.ready)?.name;
  if (!target) throw new Error("no earlier revision of this app ever started, so there is nothing to roll back to");
  await capture(["run", "services", "update-traffic", slug, "--to-revisions", `${target}=100`, "--region", REGION, "--project", PROJECT]);
  return target;
}

/** Permanently delete an app: its Cloud Run service, custom domain mapping, and
 * storage bucket. Each step is best-effort so a missing piece doesn't block. */
export async function deleteApp(slug: string): Promise<void> {
  // Two lanes, cleaned up best-effort so either is fully removed:
  //  - container: its own Cloud Run service + optional per-app bucket
  //  - static: no service — its bytes live under <slug>/ in the shared assets
  //    bucket. `run services delete` MUST be optional here, or deleting a static
  //    app throws "service not found" and fails the whole delete.
  try { await capture(["run", "services", "delete", slug, "--region", REGION, "--project", PROJECT, "--quiet"]); } catch { /* static: no per-app service */ }
  try { await capture(["beta", "run", "domain-mappings", "delete", "--domain", `${slug}.supersonic.cv`, "--region", REGION, "--project", PROJECT, "--quiet"]); } catch { /* no mapping */ }
  try { await capture(["storage", "rm", "-r", `gs://supersonicdeploy-${slug}`, "--quiet"]); } catch { /* no per-app bucket */ }
  try { await capture(["storage", "rm", "-r", `gs://${ASSETS_BUCKET}/${slug}`, "--quiet"]); } catch { /* not a static release */ }
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
