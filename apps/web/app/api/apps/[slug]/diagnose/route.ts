export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeService, getErrors } from "@/lib/gcloud";
import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";
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

// One-shot diagnosis: our resident agent reads the repo + the failing error and
// returns a surgical fix-prompt for the user's own coding agent. We never edit
// their code. If no error is supplied, we grab the latest production error.
export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ error: "forbidden" }, { status: 403 });

  let { error } = await req.json().catch(() => ({}));
  if (!error) {
    const errs = await getErrors(slug);
    if (!errs.length) return Response.json({ healthy: true, message: "no production errors in the last 7 days — nothing to diagnose" });
    error = errs[0].message;
  }

  const svc = await describeService(slug);
  if (!svc.repo) return Response.json({ error: "no source repo on file — deploy this app via Supersonic to enable diagnosis" }, { status: 400 });

  const dir = mkdtempSync(join(tmpdir(), "ss-diag-"));
  try {
    await run("git", ["clone", "--depth", "1", svc.repo, dir]);
    const fixPrompt = await diagnoseError({ dir, error: String(error) });
    // Field is "subject" (not "error") so the CLI's generic error handling
    // doesn't mistake the diagnosed error for an API failure.
    return Response.json({ subject: String(error), fixPrompt });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
