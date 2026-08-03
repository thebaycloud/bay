export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeService } from "@/lib/gcloud";
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

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ error: "forbidden" }, { status: 403 });
  const { error } = await req.json().catch(() => ({}));
  if (!error) return Response.json({ error: "no error provided" }, { status: 400 });
  const svc = await describeService(slug);
  // NO 400 without a repo any more.
  //
  // `svc.repo` is set only when the deploy carried a git URL, and the default
  // deploy is a folder upload from somebody's machine — so this endpoint refused
  // the majority of apps with "no source repo on file", about apps that had
  // deployed perfectly well. The diagnosis is worth less without the code and it
  // is worth a great deal more than a 400.
  const dir = mkdtempSync(join(tmpdir(), "ss-fix-"));
  try {
    let cloned = false;
    if (svc.repo) {
      // Still best-effort: a private repo has no credentials here, and failing
      // the whole request over that would be the 400 again by another route.
      try { await run("git", ["clone", "--depth", "1", svc.repo, dir]); cloned = true; } catch { /* diagnose without it */ }
    }
    const fixPrompt = await diagnoseError({
      error: String(error),
      dir: cloned ? dir : undefined,
      // What the platform knows, which is what makes a source-less diagnosis
      // more than a guess: the language and version it was built on, how it is
      // started, and whether it has a database.
      // Only fields describeService actually returns. The image is the useful
      // one: since the collapse it names the base the app was built on, and after
      // digest pinning it names it exactly.
      about: { slug, image: svc.image, url: svc.url, envKeys: svc.envKeys, hasDatabase: Boolean(svc.cloudsql) },
    });
    return Response.json({ fixPrompt });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
