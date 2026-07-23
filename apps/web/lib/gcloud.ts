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
}

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
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function listServices(): Promise<AppSummary[]> {
  const out = await capture(["run", "services", "list", "--region", REGION, "--project", PROJECT, "--format=json"]);
  const arr = JSON.parse(out) as any[];
  return arr.map((s) => ({
    slug: s.metadata?.name ?? "",
    url: s.status?.url ?? "",
    ready: (s.status?.conditions ?? []).find((c: any) => c.type === "Ready")?.status === "True",
    region: REGION,
    image: s.spec?.template?.spec?.containers?.[0]?.image ?? "",
  }));
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
