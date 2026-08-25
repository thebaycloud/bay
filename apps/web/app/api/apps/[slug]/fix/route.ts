export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeService } from "@/lib/gcloud";
import { getAppBySlug } from "@/lib/apps";
import { envKeysFor } from "@/lib/env-keys";
import { repoForSlug } from "@/lib/app-repos";
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
  // INSIDE the try, and allowed to fail.
  //
  // This was `const svc = await describeService(slug)` on its own line above the
  // try — and `describeService` shells out to `gcloud run services describe`,
  // which THROWS for an app on a fleet node, because such an app has no Cloud Run
  // service. Every fleet app is now every new app, so this endpoint threw for
  // most of them: Next answered an HTML 500, the caller's `r.json()` choked on it,
  // and the screen said "Couldn't reach the server" about a server that had
  // answered.
  //
  // The same defect as the agent's `keys` tool, which read describeService alone
  // and reported "no environment keys configured" about an app with five.
  const dir = mkdtempSync(join(tmpdir(), "ss-fix-"));
  try {
    const svc = await describeService(slug).catch(() => null);
    const app = await getAppBySlug(slug).catch(() => null);
    // A fleet app has no service to ask, so its variables come from its
    // placement, and its repository from the row that recorded the connection.
    const { keys } = await envKeysFor(slug).catch(() => ({ keys: null as string[] | null }));
    // THREE places a repository can be recorded, and a fleet app deployed from
    // GitHub is in the third. `svc.repo` needs a Cloud Run service; `repo_url` is
    // set by a deploy that carried a git URL; `app_repos` is where the GitHub
    // integration writes it. Reading only the first two answered "no repository"
    // about an app whose transcript begins `Pulling https://github.com/...`.
    const linked = await repoForSlug(slug).catch(() => null);
    const repo =
      svc?.repo ||
      app?.repo_url ||
      (linked ? `https://github.com/${linked.repoFullName}` : null);

    // NO 400 without a repo. `repo` is set only when the deploy carried a git
    // URL, and the default deploy is a folder upload from somebody's machine — so
    // this endpoint used to refuse the majority of apps with "no source repo on
    // file", about apps that had deployed perfectly well. The diagnosis is worth
    // less without the code and worth a great deal more than a 400.
    let cloned = false;
    if (repo) {
      // Still best-effort: a private repo has no credentials here, and failing
      // the whole request over that would be the 400 again by another route.
      try { await run("git", ["clone", "--depth", "1", repo, dir]); cloned = true; } catch { /* diagnose without it */ }
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
      // Whatever we could learn, from whichever runtime answered. Absent fields
      // are omitted rather than sent as null: a diagnosis is better with less
      // than it is with a field that claims the app has no database because we
      // could not ask.
      about: {
        slug,
        runtime: svc ? "cloudrun" : "fleet",
        ...(svc?.image ? { image: svc.image } : {}),
        ...(svc?.url ? { url: svc.url } : {}),
        ...(keys?.length ? { envKeys: keys } : {}),
        ...(svc ? { hasDatabase: Boolean(svc.cloudsql) } : {}),
        ...(repo ? { repo } : {}),
        ...(linked?.branch ? { branch: linked.branch } : {}),
      },
    });
    return Response.json({ fixPrompt });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
