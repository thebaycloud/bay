export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeService, ownsApp } from "@/lib/gcloud";
import { currentUserId } from "@/lib/session";
import { diagnoseError } from "@/lib/agent";

const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH ?? ""}` } as NodeJS.ProcessEnv;

function run(cmd: string, args: string[]) {
  return new Promise<void>((res, rej) => {
    const p = spawn(cmd, args, { env: ENV });
    let e = "";
    p.stderr.on("data", (d: Buffer) => (e += d));
    p.on("error", rej);
    p.on("close", (c) => (c === 0 ? res() : rej(new Error(e.trim() || `${cmd} exited ${c}`))));
  });
}

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ error: "forbidden" }, { status: 403 });
  const { error } = await req.json().catch(() => ({}));
  if (!error) return Response.json({ error: "no error provided" }, { status: 400 });
  const svc = await describeService(slug);
  if (!svc.repo) return Response.json({ error: "no source repo on file for this app — deploy it via Supersonic to enable fixes" }, { status: 400 });
  const dir = mkdtempSync(join(tmpdir(), "ss-fix-"));
  try {
    await run("git", ["clone", "--depth", "1", svc.repo, dir]);
    const fixPrompt = await diagnoseError({ dir, error: String(error) });
    return Response.json({ fixPrompt });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
