export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudRunName } from "@/lib/slug";
import { currentUserId } from "@/lib/session";

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
  const dir = mkdtempSync(join(tmpdir(), "ss-detect-"));
  try {
    await run("git", ["clone", "--depth", "1", url, dir]);
    const raw = await capture("npm", ["--prefix", AGENT, "run", "detect", "--silent", "--", dir, "--api"]);
    const det = JSON.parse(raw.slice(raw.indexOf("{")));
    return Response.json({
      slug,
      framework: det.stack.framework,
      language: det.stack.language,
      dbEngine: det.stack.database?.engine ?? null,
      secretsNeeded: det.stack.secretsNeeded ?? [],
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
