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
import { getDeploy } from "@/lib/deploys";

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
    if (errs.length) {
      error = errs[0].message;
    } else {
      // "No production errors" is only good news for an app that reached
      // production. An app whose deploy failed has no service, so it logs no
      // errors — and this route used to congratulate it on being healthy, which
      // is the single most misleading thing it could say to someone who came
      // here precisely because their app is not working. The deploy record
      // knows the difference.
      const deploy = await getDeploy(slug);
      if (deploy?.status === "failed") {
        error = deploy.error || "the last deploy failed";
      } else if (deploy?.status === "building") {
        return Response.json({ healthy: false, message: `${slug} is still deploying — nothing to diagnose until it lands` });
      } else {
        return Response.json({ healthy: true, message: "no production errors in the last 7 days — nothing to diagnose" });
      }
    }
  }

  const svc = await describeService(slug);
  // NO 400 without a repo any more.
  //
  // `svc.repo` is set only when the deploy carried a git URL, and the default
  // deploy is a folder upload from somebody's machine — so this endpoint refused
  // the majority of apps with "no source repo on file", about apps that had
  // deployed perfectly well. The diagnosis is worth less without the code and it
  // is worth a great deal more than a 400.

  const dir = mkdtempSync(join(tmpdir(), "ss-diag-"));
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
    // Field is "subject" (not "error") so the CLI's generic error handling
    // doesn't mistake the diagnosed error for an API failure.
    return Response.json({ subject: String(error), fixPrompt });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
