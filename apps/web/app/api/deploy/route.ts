export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { cloudRunName } from "@/lib/slug";
import { currentUserId } from "@/lib/session";
import { getPool } from "@/lib/db";
import { resolveSlug } from "@/lib/gcloud";
import { entitlement, countOwnerApps, type Limits } from "@/lib/entitlements";
import { runDeploy } from "@/lib/deploy-pipeline";
import { createRun, startDeployJob, finishRun, pruneRuns } from "@/lib/deploy-runs";
import { readEvents, pruneEvents } from "@/lib/deploy-events";
import { getDeploy } from "@/lib/deploys";
import { StageRecorder } from "@/lib/stages";

const REGION = "us-central1";
// Dark until set, and the in-request path below stays exactly as it was. This
// changes where every deploy runs, so it gets the same treatment as the runner
// and the planner did: switch it on, watch it, and keep the old path one env var
// away for as long as that is worth having.
const DEPLOY_JOB = process.env.DEPLOY_JOB === "1";
const DEPLOY_JOB_NAME = process.env.DEPLOY_JOB_NAME || "supersonic-deploy-job";

const SSE_HEADERS = {
  headers: {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  },
};

/**
 * Narrate a job-run deploy by reading its event log.
 *
 * The events are already durable before this reads them, which is the whole
 * point: this stream can die, reconnect, or never be read at all and the deploy
 * is unaffected — and a client that lost it can catch up from the same table via
 * deploy-status rather than guessing from a closed socket.
 *
 * Two ways to end. Normally a `done` or `error` event arrives and the stream
 * closes behind it. Otherwise the deploys row is consulted: a job that was killed
 * outright writes no terminal event, and without this check the reader would sit
 * on a silent stream until it timed out, which is exactly the false "it hung"
 * this is meant to remove.
 */
function tailDeployRun(runId: string, slug: string): ReadableStream {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => {
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`)); return true; }
        catch { return false; }        // client gone — stop reading, the job carries on
      };
      let after = 0;
      let silentFor = 0;
      try {
        for (;;) {
          const events = await readEvents(runId, after);
          for (const { id, event } of events) {
            after = id;
            if (!send(event)) return;
            if (event?.type === "done" || event?.type === "error") return;
          }
          silentFor = events.length ? 0 : silentFor + 1;
          // ~15s of nothing new: ask the record whether this deploy is over. A
          // job that died mid-build never gets to say so itself.
          if (silentFor >= 30) {
            silentFor = 0;
            const row = await getDeploy(slug);
            if (row && (row.status === "live" || row.status === "failed")) {
              // One more pass, in case the terminal event landed between the last
              // read and this check.
              for (const { id, event } of await readEvents(runId, after)) { after = id; send(event); }
              if (row.status === "live") send({ type: "done", slug, url: row.url });
              else send({ type: "error", message: row.error || "the deploy failed" });
              return;
            }
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      } finally {
        controller.close();
      }
    },
  });
}

function normalizeRepo(raw: string): string {
  const r = raw.trim();
  if (r.startsWith("git@") || /^https?:\/\//.test(r) || r.startsWith("file://")) return r;
  if (/^github\.com\//.test(r)) return "https://" + r;
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return "https://github.com/" + r; // owner/repo
  return "https://" + r;
}

/**
 * The `x-supersonic-env` header: base64 JSON of the vars the CLI read from the
 * project's local `.env`.
 *
 * Everything here comes from a client we do not control, and each pair ends up on a
 * `gcloud run deploy` command line, so the shape is checked rather than trusted: real
 * environment-variable names, string values, and a ceiling on how many. Anything that
 * fails the check is dropped — a malformed header must not take the deploy down with it.
 */
function decodeEnvHeader(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
      if (typeof v !== "string" || !v) continue;
      out[k] = v;
      if (Object.keys(out).length >= 100) break;
    }
  } catch {
    return {};
  }
  return out;
}

export async function POST(req: Request) {
  const ownerId = await currentUserId();
  // The middleware waves any request carrying an `Authorization: Bearer …`
  // header past the cookie gate, on the promise that the route validates the
  // token itself. This route never did: currentUserId() returns null for a
  // bogus token and every use below is `if (ownerId)`-guarded, so an anonymous
  // caller skipped the bookkeeping and still reached `git clone` → container
  // build → Cloud Run deploy under our own service account. That is
  // unauthenticated code execution in our project, reachable by anyone who
  // sends one junk header. Refuse before anything else runs.
  if (!ownerId) return Response.json({ error: "not signed in" }, { status: 401 });
  const ownerWorkspace = ownerId
    ? (await getPool("supersonic_platform").query(
        `SELECT workspace_id FROM users WHERE id = $1`, [ownerId]
      )).rows[0]?.workspace_id ?? null
    : null;
  // Two ingest doors: a git URL (clone) or a project uploaded straight from the
  // user's computer (a gzipped tar of the folder). Both end in a populated dir,
  // after which the pipeline is identical.
  const isUpload = req.headers.get("x-supersonic-upload") === "1";
  // A third door: the CLI already built the project on the user's machine and is
  // sending only the output directory. Nothing here is detected, installed or built —
  // the bytes are published as a release, which is the whole ~80s-to-~15s difference.
  const isPrebuilt = isUpload && req.headers.get("x-supersonic-prebuilt") === "1";
  const prebuiltHash = (req.headers.get("x-supersonic-hash") ?? "").trim().toLowerCase();
  let url = "";
  let slug = "";
  let friendlyName = "app";
  let secrets: Record<string, string> = {};
  let archive: Buffer | null = null;
  let cloneToken: unknown = null;
  let reservedSlug = "";
  // The production run command the deploying agent worked out for this app (e.g.
  // `uvicorn main:app --host 0.0.0.0 --port $PORT`, `next start`). It's the reliable
  // answer to "how do I run this" — especially for Python, which can't be guessed.
  // The runner uses it as SUPERSONIC_RUN; empty falls back to a Node-only default.
  let runCmd = "";
  if (isUpload) {
    archive = Buffer.from(await req.arrayBuffer());
    friendlyName = cloudRunName(req.headers.get("x-supersonic-app") || "app");
    reservedSlug = (req.headers.get("x-supersonic-slug") ?? "").trim();
    runCmd = decodeURIComponent(req.headers.get("x-supersonic-run") ?? "").trim();
    // The app's own secrets, from the CLI's reading of the project's local `.env`.
    // They arrive in a header because the body is the tarball — and deliberately NOT
    // inside it: a secret in the archive is copied into the build bucket and baked
    // into the image, where it cannot be rotated. Here it becomes an env var on the
    // service, applied to the first revision, so the app starts with what it needs.
    secrets = decodeEnvHeader(req.headers.get("x-supersonic-env"));
  } else {
    const body = await req.json().catch(() => ({}));
    url = normalizeRepo(String(body.repo ?? ""));
    friendlyName = cloudRunName(url);
    secrets = (body.secrets ?? {}) as Record<string, string>;
    cloneToken = body.cloneToken ?? null;
    reservedSlug = String(body.slug ?? "").trim();
    runCmd = String(body.run ?? "").trim();
  }
  // Apps get a short random subdomain (e.g. as76d.supersonic.cv). A reserved slug
  // (URL-first / tunnel deploys) is honoured so the build lands on the URL already
  // shown; otherwise redeploys reuse the slug by matching the friendly name.
  slug = reservedSlug || await resolveSlug(ownerId || "", friendlyName);

  // Plan enforcement (inert until GATING_ENABLED=1 — see lib/entitlements).
  // Checked up front so a blocked deploy fails cleanly with a 402 instead of
  // erroring mid-stream. `limits` also decides, further down, whether a failed
  // deploy gets the auto-fix agent (pro/trial) or a paste prompt (basic).
  const ent = await entitlement(ownerId);
  const limits: Limits = ent.limits;
  if (ent.locked) {
    // Trial ended (or subscription canceled) — hard paywall.
    return Response.json(
      { error: "Your free trial has ended. Pick a plan at app.supersonic.cv to keep deploying.", paywall: true },
      { status: 402 }
    );
  }
  if (Number.isFinite(limits.maxApps)) {
    const existing = await countOwnerApps(ownerId, slug);
    if (existing >= limits.maxApps) {
      return Response.json(
        {
          error: `Your plan includes ${limits.maxApps} app. Upgrade to Pro for unlimited apps at app.supersonic.cv.`,
          upgrade: true,
        },
        { status: 402 }
      );
    }
  }


  const input = {
    ownerId, ownerWorkspace, slug, friendlyName, repoUrl: url,
    isUpload, isPrebuilt, prebuiltHash, secrets, cloneToken, runCmd, limits,
  };

  // Hand the deploy to a job and stream back its event log. The request stops
  // being the worker: it records the work, starts it, and narrates. Whether this
  // connection survives no longer decides whether the app gets deployed.
  if (DEPLOY_JOB) {
    let runId: string | null = null;
    // The largest single item in the deploy budget, and the only one nothing
    // measures. On 1 Aug, 79 seconds passed between the CLI finishing its upload
    // and the pipeline logging its first line; on the same fixture on 1 Aug it
    // was 227. Job scheduling, container cold start, image pull and the archive
    // round-trip are all plausible causes and, recorded as one lump, entirely
    // indistinguishable — so any fix would be a guess.
    //
    // Split at the two boundaries this process can actually see. The third,
    // "job accepted → job running", belongs to the job and is recorded there.
    const handoff = new StageRecorder(slug, "unknown");
    try {
      const recording = handoff.start("run-record");
      runId = await createRun(input, archive);
      await handoff.end(recording, "ok");

      const dispatch = handoff.start("job-dispatch");
      await startDeployJob(runId, REGION, DEPLOY_JOB_NAME);
      await handoff.end(dispatch, "ok");
    } catch (e) {
      // The record holds the app's secrets and exists only so a job can pick it
      // up. If no job ever will, it is deleted now rather than left for the
      // six-hour sweep — the window those secrets are stored for should be the
      // length of a build, not the length of a timeout nobody is watching.
      if (runId) await finishRun(runId).catch(() => {});
      // Nothing has started, so this is an honest, immediate failure rather than
      // a deploy that will quietly never happen.
      return Response.json({ error: `could not start the deploy: ${e instanceof Error ? e.message : String(e)}` }, { status: 503 });
    }
    // Housekeeping for whatever previous runs were abandoned. Not awaited: it is
    // maintenance, and a slow sweep must not delay someone's deploy.
    void pruneRuns(); void pruneEvents();
    return new Response(tailDeployRun(runId, slug), SSE_HEADERS);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      // Enqueue must never throw into the deploy: once the CLI returns the live
      // URL it detaches, and a build now routinely finishes with no client
      // listening. If the stream is already closed the progress line is simply
      // dropped — the build carries on to completion regardless.
      const send = (o: unknown) => {
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`)); }
        catch { /* client gone — keep building, just stop narrating */ }
      };
      try {
        await runDeploy({ ...input, archive }, send);
      } finally {
        controller.close();
      }
    },
  });


  return new Response(stream, SSE_HEADERS);
}
