import { spawn } from "node:child_process";

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
  url: string;
  ready: boolean;
  region: string;
  image: string;
  owner: string;
}

const OWNER_LABEL = "supersonic-owner";

export interface ServiceInfo {
  slug: string;
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
export async function listServices(ownerId?: string): Promise<AppSummary[]> {
  const out = await capture(["run", "services", "list", "--region", REGION, "--project", PROJECT, "--format=json"]);
  const arr = JSON.parse(out) as any[];
  return arr
    .filter((s) => !ownerId || s.metadata?.labels?.[OWNER_LABEL] === ownerId)
    .map((s) => ({
      slug: s.metadata?.name ?? "",
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

export async function describeService(slug: string): Promise<ServiceInfo> {
  const out = await capture(["run", "services", "describe", slug, "--region", REGION, "--project", PROJECT, "--format=json"]);
  const s = JSON.parse(out) as any;
  const c = s.spec?.template?.spec?.containers?.[0] ?? {};
  const ann = s.spec?.template?.metadata?.annotations ?? {};
  return {
    slug: s.metadata?.name ?? slug,
    url: s.status?.url ?? "",
    ready: (s.status?.conditions ?? []).find((x: any) => x.type === "Ready")?.status === "True",
    region: REGION,
    created: s.metadata?.creationTimestamp ?? "",
    revision: s.status?.latestReadyRevisionName ?? s.status?.latestCreatedRevisionName ?? "",
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

function accessToken(): Promise<string> {
  return capture(["auth", "print-access-token"]).then((s) => s.trim());
}

export async function listBucketObjects(bucket: string): Promise<{ name: string; size: number; updated: string; contentType: string }[]> {
  const t = await accessToken();
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${bucket}/o?maxResults=200`, {
    headers: { Authorization: "Bearer " + t, "x-goog-user-project": PROJECT },
  });
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

export interface Revision { name: string; created: string; active: boolean; }

export async function listRevisions(slug: string): Promise<Revision[]> {
  const out = await capture(["run", "revisions", "list", "--service", slug, "--region", REGION, "--project", PROJECT, "--format=json"]);
  const arr = JSON.parse(out) as any[];
  return arr
    .map((r) => ({
      name: r.metadata?.name ?? "",
      created: r.metadata?.creationTimestamp ?? "",
      active: (r.status?.conditions ?? []).some((c: any) => c.type === "Active" && c.status === "True"),
    }))
    .sort((a, b) => (a.created < b.created ? 1 : -1));
}

/** Roll traffic back to the previous ready revision. Returns the revision now serving. */
export async function rollback(slug: string): Promise<string> {
  const revs = await listRevisions(slug);
  if (revs.length < 2) throw new Error("no previous revision to roll back to");
  const target = revs[1].name; // [0] is current, [1] is the one before
  await capture(["run", "services", "update-traffic", slug, "--to-revisions", `${target}=100`, "--region", REGION, "--project", PROJECT]);
  return target;
}

const DEPLOYER_SA = "supersonic-deployer@supersonic-deploy-prod.iam.gserviceaccount.com";

// Cloud Run has no exec-into-a-running-instance. So we run the command in a
// one-off Cloud Run Job built from the app's own image + env + Cloud SQL — an
// isolated instance that can't affect the serving app. The command is passed
// base64-encoded via an env var so no shell-escaping games are needed.
export async function execCommand(slug: string, command: string): Promise<{ output: string; exitCode: number }> {
  const raw = await capture(["run", "services", "describe", slug, "--region", REGION, "--project", PROJECT, "--format=json"]);
  const s = JSON.parse(raw) as any;
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
