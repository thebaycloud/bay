export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { forbiddenBody } from "@/lib/api-error";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeService, getErrors } from "@/lib/gcloud";
import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";
import { diagnoseError } from "@/lib/agent";
import { getDeploy } from "@/lib/deploys";
import { getAppBySlug } from "@/lib/apps";
import { envKeysFor } from "@/lib/env-keys";
import { repoForSlug } from "@/lib/app-repos";
import { readLatestRunLines } from "@/lib/deploy-events";

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
  if (!uid || !(await ownsApp(slug, uid))) return Response.json(forbiddenBody(), { status: 403 });

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
        // HOW LONG, and whether anything has come out of it.
        //
        // "Still deploying" is true and useless after twelve minutes. A deploy
        // report recorded two builds sitting at `reserved` for twelve and nine
        // minutes, having emitted a single status echo between them, while this
        // endpoint said the same seven words each time. The actionable fact is
        // not that it is building — it is that it has been building for a quarter
        // of an hour and has printed nothing, which is a stall and not progress.
        // `updatedAt` is the only clock on the row, and during a STALL it is the
        // right one: nothing is updating it, so it holds the moment progress
        // stopped rather than the moment the deploy began. That is the number
        // somebody wants — how long since anything happened.
        const since = deploy.updatedAt ?? null;
        const mins = since ? Math.floor((Date.now() - new Date(since).getTime()) / 60000) : null;
        const lines = await readLatestRunLines(slug, 5).catch(() => []);
        const stalled = mins !== null && mins >= 5 && lines.length <= 1;
        return Response.json({
          healthy: false,
          message: stalled
            ? `${slug} has been deploying for ${mins} minutes and its build has printed nothing` +
              `${deploy.stage ? ` — stuck at "${deploy.stage}"` : ""}. That is a stall rather than a slow build:` +
              ` nothing here will change by waiting. Ship again with --prebuilt to build on your machine and skip ours.`
            : `${slug} is still deploying${mins !== null ? ` (${mins} min)` : ""}` +
              `${deploy.stage ? ` — ${deploy.stage}` : ""} — nothing to diagnose until it lands`,
          stalled,
          minutes: mins,
          stage: deploy.stage ?? null,
        });
      } else {
        return Response.json({ healthy: true, message: "no production errors in the last 7 days — nothing to diagnose" });
      }
    }
  }

  const dir = mkdtempSync(join(tmpdir(), "ss-diag-"));
  try {
    // INSIDE the try, and allowed to fail — the same fix `/fix` needed, in the
    // command a deploy report actually ran. `describeService` shells out to
    // `gcloud run services describe`, which THROWS for an app on a fleet node,
    // and every new app is a fleet app. Unguarded and above the try, it made this
    // endpoint 500 for most apps: `bay diagnose` printed nothing at all, which is
    // how twelve minutes of a stalled build went unexplained.
    //
    // The FIFTH place this same mistake has been found. `envKeysFor` exists
    // because of the first one.
    const svc = await describeService(slug).catch(() => null);
    const app = await getAppBySlug(slug).catch(() => null);
    const { keys } = await envKeysFor(slug).catch(() => ({ keys: null as string[] | null }));
    // Three places a repository can be recorded; a fleet app deployed from GitHub
    // is in the third.
    const linked = await repoForSlug(slug).catch(() => null);
    const repo =
      svc?.repo ||
      app?.repo_url ||
      (linked ? `https://github.com/${linked.repoFullName}` : null);

    // NO 400 without a repo. The default deploy is a folder upload from
    // somebody's machine, so requiring one refused the majority of apps about
    // apps that had deployed perfectly well.
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
      // Whatever we could learn, from whichever runtime answered. Absent fields
      // are omitted rather than sent as null: a diagnosis is better with less
      // than with a field claiming the app has no database because we could not
      // ask.
      about: {
        slug,
        runtime: svc ? "cloudrun" : "fleet",
        ...(svc?.image ? { image: svc.image } : {}),
        ...(svc?.url ? { url: svc.url } : {}),
        ...(keys?.length ? { envKeys: keys } : {}),
        ...(svc ? { hasDatabase: Boolean(svc.cloudsql) } : {}),
        ...(repo ? { repo } : {}),
      },
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
