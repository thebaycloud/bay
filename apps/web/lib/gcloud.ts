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
    envKeys: (c.env ?? []).map((e: any) => e.name).filter(Boolean),
    cloudsql: ann["run.googleapis.com/cloudsql-instances"] ?? "",
  };
}
