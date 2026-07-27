export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { spawn } from "node:child_process";
import { join } from "node:path";
import { cloudRunName } from "@/lib/slug";
import { currentUserId } from "@/lib/session";
import { put, reserve, discard, sweep } from "@/lib/clone-cache";

const AGENT = join(process.cwd(), "..", "..", "services", "deploy-agent");
const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH ?? ""}`, CLOUDSDK_CORE_DISABLE_PROMPTS: "1" } as NodeJS.ProcessEnv;

function normalizeRepo(raw: string): string {
  const r = raw.trim();
  if (r.startsWith("git@") || /^https?:\/\//.test(r) || r.startsWith("file://")) return r;
  if (/^github\.com\//.test(r)) return "https://" + r;
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return "https://github.com/" + r;
  return "https://" + r;
}
function run(cmd: string, args: string[]) {
  return new Promise<void>((res, rej) => {
    const p = spawn(cmd, args, { env: ENV }); let e = "";
    p.stderr.on("data", (d: Buffer) => (e += d));
    p.on("error", rej); p.on("close", (c) => (c === 0 ? res() : rej(new Error(e.trim() || `${cmd} exited ${c}`))));
  });
}
function capture(cmd: string, args: string[]) {
  return new Promise<string>((res, rej) => {
    const p = spawn(cmd, args, { env: ENV }); let o = "", e = "";
    p.stdout.on("data", (d: Buffer) => (o += d)); p.stderr.on("data", (d: Buffer) => (e += d));
    p.on("error", rej); p.on("close", (c) => (c === 0 ? res(o) : rej(new Error(e.trim() || `${cmd} exited ${c}`))));
  });
}

export async function POST(req: Request) {
  // Same hole as /api/deploy: a junk `Authorization: Bearer …` header clears
  // the middleware's cookie gate, and this route had no check of its own — so
  // anyone could make the control plane `git clone` a URL of their choosing.
  // normalizeRepo passes file:// through and prefixes anything else with
  // https://, which puts internal hosts in reach too.
  if (!(await currentUserId())) return Response.json({ error: "not signed in" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const url = normalizeRepo(String(body.repo ?? ""));
  const slug = cloudRunName(url);
  // The clone is kept instead of thrown away, so /api/deploy can reuse it rather
  // than fetching the same repository a second time. Sweeping here keeps
  // abandoned deploys — someone closing the tab at the secrets step — from
  // filling the instance's disk.
  sweep();
  const dir = reserve();
  let keep = false;
  try {
    await run("git", ["clone", "--depth", "1", url, dir]);
    const raw = await capture("npm", ["--prefix", AGENT, "run", "detect", "--silent", "--", dir, "--api"]);
    const det = JSON.parse(raw.slice(raw.indexOf("{")));
    keep = true;
    return Response.json({
      slug,
      framework: det.stack.framework,
      language: det.stack.language,
      dbEngine: det.stack.database?.engine ?? null,
      secretsNeeded: det.stack.secretsNeeded ?? [],
      serve: det.stack.serve ?? { mode: "container" },
      cloneToken: put(dir),
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  } finally {
    if (!keep) discard(dir);
  }
}
