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
