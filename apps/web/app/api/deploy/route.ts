export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { cloudRunName } from "@/lib/slug";
import { currentUserId } from "@/lib/session";
import { getPool } from "@/lib/db";
import { resolveSlug } from "@/lib/gcloud";
import { entitlement, countOwnerApps, type Limits } from "@/lib/entitlements";
import { runDeploy } from "@/lib/deploy-pipeline";

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
        await runDeploy({
          ownerId, ownerWorkspace, slug, friendlyName, repoUrl: url,
          isUpload, isPrebuilt, prebuiltHash, secrets, archive, cloneToken, runCmd, limits,
        }, send);
      } finally {
        controller.close();
      }
    },
  });


  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
