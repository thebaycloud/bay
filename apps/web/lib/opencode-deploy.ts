/**
 * Repair a failed deploy with opencode — the drop-in replacement for the bespoke
 * Gemini loop in lib/agent.ts (`repairDeploy`). Same contract, same `redeploy`
 * closure (the REAL Cloud Run pipeline): opencode edits the repo copy and calls
 * `redeploy` to re-run the actual deploy until it comes up live.
 *
 * opencode runs as a subprocess; `redeploy` is an in-process closure. They are
 * bridged by a tiny localhost HTTP server: the agent runs `redeploy.sh`, which
 * POSTs to the bridge, which invokes `redeploy()` and returns {ok,url,error}.
 *
 * Model is provider-agnostic; config points at Vertex Gemini via the gcloud token
 * (no API key). Selected by DEPLOY_ENGINE=opencode on the control plane.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { AddressInfo } from "node:net";
import { accessToken as restAccessToken } from "./gcp-rest";

const PROJECT = process.env.OPENCODE_VERTEX_PROJECT || "supersonic-deploy-prod";
const LOCATION = "us-central1";
const MODEL = process.env.OPENCODE_MODEL || "vertex/google/gemini-2.5-pro";
const MAX_REDEPLOYS = Number(process.env.OPENCODE_MAX_REDEPLOYS || 3);

export interface TokenUsage { total: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; }
export interface RepairResult { ok: boolean; url?: string; changes: string[]; summary: string; tokens: TokenUsage; steps: number; redeploys: number; }

type Redeploy = () => Promise<{ ok: boolean; url?: string; error?: string }>;

function opencodeBin(): string {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  const home = join(homedir(), ".opencode", "bin", "opencode");
  return existsSync(home) ? home : "opencode";
}

/** Shared in-memory cache first (no subprocess), the gcloud spawn as fallback. */
async function gcloudToken(): Promise<string> {
  const shared = await restAccessToken();
  if (shared) return shared;
  return new Promise<string>((resolve, reject) => {
    const p = spawn("gcloud", ["auth", "print-access-token"], {
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH ?? ""}` },
    });
    let out = "", err = "";
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.stderr.on("data", (d: Buffer) => (err += d));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || "token failed"))));
  });
}

const AGENT_MD = `---
description: Autonomous deployment engineer that repairs a failed deploy
mode: primary
temperature: 0.1
permission:
  bash: allow
  edit: allow
  webfetch: deny
---

You are an autonomous deployment engineer. The web application in the \`./repo\` directory FAILED to deploy to a cloud host. Your job is to fix the repository so it deploys and serves live HTTP traffic.

To (re)deploy, run this exact command:

    bash redeploy.sh

It runs the real deploy pipeline and prints \`DEPLOY_OK: <url>\` when the app is live, or \`DEPLOY_FAIL: <the real error>\` when it fails again. Each run is slow (a real cloud build + deploy).

Workflow:
1. Read the error you were given, inspect the relevant files in \`./repo\`, and make the smallest correct change that addresses that specific error.
2. Run \`bash redeploy.sh\`.
3. If it prints \`DEPLOY_OK\`, you are done: report the live URL and stop.
4. If it prints \`DEPLOY_FAIL\`, read the new error and repeat.

Rules:
- Only edit files inside \`./repo\`.
- Make minimal, targeted changes that fix the actual error — do not rewrite whole files.
- Read the error output's own hints (for example a "Possible solutions" section) before guessing.
- Never edit \`redeploy.sh\`, \`opencode.json\`, or anything under \`.opencode/\`.
- Do not add a web server or Dockerfile unless the error clearly calls for it; prefer fixing configuration.
- When the app is live, stop and briefly report what you changed and the URL.
`;

function redeployScript(port: number): string {
  return `#!/usr/bin/env bash
# Bridge to the real Supersonic deploy pipeline running in the control plane.
set -uo pipefail
HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
R=$(curl -s -X POST "http://127.0.0.1:${port}/redeploy" --max-time 1200)
OK=$(node -e 'try{process.stdout.write(String(JSON.parse(process.argv[1]).ok))}catch{process.stdout.write("false")}' "$R")
URL=$(node -e 'try{process.stdout.write(JSON.parse(process.argv[1]).url||"")}catch{}' "$R")
ERR=$(node -e 'try{process.stdout.write(JSON.parse(process.argv[1]).error||"")}catch{}' "$R")
if [ "$OK" = "true" ]; then
  echo "DEPLOY_OK: $URL"
  printf '{"ok":true,"url":"%s"}' "$URL" > "$HERE/.deploy.result"
else
  echo "DEPLOY_FAIL: $ERR"
  printf '{"ok":false}' > "$HERE/.deploy.result"
fi
`;
}

// ============================ PLANNER =====================================
// Instead of a hardcoded stack detector, opencode READS the repo once and hands
// back a deploy plan the runner executes verbatim. This is the "USE AGENTS"
// path: no framework matrix baked into the platform, no per-stack Dockerfiles —
// the agent that can read the code decides how to install/build/run it.

export interface DeployPlan {
  language: "node" | "python" | "static" | "other";
  install?: string;      // override the runner's language-default install
  build?: string;        // build step, or "" for none
  run: string;           // production run cmd; MUST bind 0.0.0.0 on $PORT (server apps)
  static?: boolean;      // true → serve built assets statically, no server process
  outputDir?: string;    // static only: the built directory (e.g. "dist", "out", "build")
  needsDB?: boolean;     // provision Postgres and inject DATABASE_URL
  preRun?: string[];     // one-shot pre-serve steps (migrations, e.g. "npx prisma migrate deploy")
  port?: number;         // only if the app hardcodes a port instead of reading $PORT
  envNeeded?: string[];  // env var NAMES the app reads (surfaced to the user; never values)
  reason?: string;       // one line: how the agent read the stack (for logs)
}

const PLAN_AGENT_MD = `---
description: Reads a repo and outputs a deploy plan as JSON
mode: primary
temperature: 0
permission:
  bash: allow
  edit: deny
  webfetch: deny
---

You inspect the web app in \`./repo\` and output a single JSON deploy plan. You do NOT modify the app — decide how it is installed, built, and run in production on a cloud host that injects a \`$PORT\` env var.

Work QUICKLY and efficiently — a handful of tool calls, not many. Read what you need and no more:
- the dependency manifest: \`package.json\` (or \`requirements.txt\` / \`pyproject.toml\`),
- the build/output config the manifest points to: \`nx.json\`/\`project.json\` (Nx), \`vite.config.*\`, \`next.config.*\`, \`Procfile\`, or the main entry file,
- a \`README\`/deployment doc if present — it OFTEN states the exact production install/build/run commands verbatim; prefer them when it does,
- the ORM schema/config location if the app uses one.
Do NOT list the same directory twice or re-read a file. Once you can name install/build/run, WRITE the plan and STOP.

Don't forget code-generation and migration steps that a fresh checkout needs:
- If the app uses an ORM with a generated client (Prisma \`prisma generate\`, etc.), that generation MUST happen — put it in \`build\` (or first in \`preRun\`), or the client is missing at runtime.
- If a migrations directory exists, run the deploy migration (Prisma \`prisma migrate deploy\`) in \`preRun\`.
- Tools resolve their own config: if package.json has a \`"prisma": { "schema": ... }\` block, plain \`prisma\` commands find it — no path flag needed.

Investigate first with bash (ls, cat, grep). When you have decided, WRITE the plan as a single JSON object to the exact file path given in the task prompt, using bash — for example:

    cat > /the/given/path/plan.json <<'JSON'
    { ...the plan... }
    JSON

Writing that file is how you deliver the plan (do not rely on printing it in chat). After writing it, stop. The JSON shape:

{
  "language": "node" | "python" | "static" | "other",
  "install": "<install cmd, or omit to use the platform default (npm ci / pip install)>",
  "build": "<build cmd, or \\"\\" if none>",
  "run": "<production run command that binds 0.0.0.0 on $PORT>",
  "static": <true only for pure client-side apps with no server>,
  "outputDir": "<for static: the built directory, e.g. dist / out / build>",
  "needsDB": <true if the app needs a Postgres database>,
  "preRun": ["<one-shot steps before serving, e.g. npx prisma migrate deploy>"],
  "envNeeded": ["<env var NAMES the app reads, excluding PORT and DATABASE_URL>"],
  "reason": "<one short line: how you read the stack>"
}

Rules:
- The run command is the most important field. It MUST bind 0.0.0.0 and use the \`$PORT\` the platform injects — never a hardcoded port, never a dev server that binds localhost.
  - FastAPI: \`uvicorn main:app --host 0.0.0.0 --port $PORT\`  · Flask: \`gunicorn app:app --bind 0.0.0.0:$PORT\` · Django: \`gunicorn <proj>.wsgi --bind 0.0.0.0:$PORT\`
  - Next (built): \`next start -p $PORT\` · Node/Express: the real server entry, e.g. \`node server.js\` (it must read process.env.PORT)
- A React/Vite/CRA SPA with no backend is \`"static": true\` with its build output in \`outputDir\`; \`run\` may be "".
- Never invent secrets. \`envNeeded\` is names only. Omit DATABASE_URL — the platform provides it when needsDB is true.
- Prefer the app's own scripts/config over guessing. If a Procfile or a documented start command exists, use it.
- Deliver the plan by WRITING it to the given file path. That file is the deliverable.
`;

/** Pull the last well-formed JSON object out of opencode's final text. */
function extractPlan(text: string): DeployPlan | null {
  // opencode may wrap it in prose or a ```json fence; scan for the last balanced {...}.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fence) candidates.push(fence[1]);
  // Greedy last-object fallback: find each top-level { ... } by brace balance.
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") { depth--; if (depth === 0 && start >= 0) candidates.push(text.slice(start, i + 1)); }
  }
  for (const c of candidates.reverse()) {
    try {
      const o = JSON.parse(c);
      if (o && typeof o === "object" && ("run" in o || "static" in o || "language" in o)) return o as DeployPlan;
    } catch { /* try the next candidate */ }
  }
  return null;
}

/**
 * Ask opencode to read the repo and produce a deploy plan. Read-only (edit denied),
 * no redeploy bridge — it inspects and returns. Throws on any failure so the caller
 * can fall back to the deterministic detector. Same env-hardening as opencodeRepair.
 */
export async function planDeploy(opts: {
  dir: string;
  log: (l: string) => void;
  timeoutMs?: number;
}): Promise<DeployPlan> {
  const { dir, log } = opts;
  const timeoutMs = opts.timeoutMs ?? Number(process.env.PLANNER_TIMEOUT_MS || 240000);

  const ws = mkdtempSync(join(tmpdir(), "ss-plan-"));
  const dataHome = mkdtempSync(join(tmpdir(), "ss-plandata-"));
  const planPath = join(ws, "plan.json");   // the agent writes the plan here (proven pattern; robust to event-stream shape)
  let finalText = "";
  let fileText = "";
  try {
    symlinkSync(dir, join(ws, "repo"));
    const token = await gcloudToken();
    writeFileSync(join(ws, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      provider: { vertex: { npm: "@ai-sdk/openai-compatible", name: "Vertex Gemini", options: {
        baseURL: `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${LOCATION}/endpoints/openapi`,
        apiKey: token,
      }, models: { "google/gemini-2.5-pro": { name: "Gemini 2.5 Pro" } } } },
    }, null, 2));
    mkdirSync(join(ws, ".opencode", "agent"), { recursive: true });
    writeFileSync(join(ws, ".opencode", "agent", "plan.md"), PLAN_AGENT_MD);

    const prompt = `Read the app in ./repo and produce its deploy plan (see your instructions). Investigate the files first, then WRITE the plan as a single JSON object to this exact file path using bash:\n\n    ${planPath}\n\nThat file is your deliverable. After writing it, stop.`;
    const args = ["run", "--agent", "plan", "--model", MODEL, "--auto", "--format", "json", prompt];

    await new Promise<void>((resolve) => {
      const childEnv: NodeJS.ProcessEnv = {
        NODE_ENV: process.env.NODE_ENV || "production",
        HOME: homedir(),
        PATH: `${join(homedir(), ".opencode", "bin")}:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}`,
        TMPDIR: tmpdir(),
        LANG: process.env.LANG || "en_US.UTF-8",
        USER: process.env.USER || "supersonic",
        XDG_DATA_HOME: dataHome,
      };
      const p = spawn(opencodeBin(), args, { cwd: ws, stdio: ["ignore", "pipe", "pipe"], env: childEnv });
      const killer = setTimeout(() => { log("planner · timed out"); try { p.kill("SIGKILL"); } catch { /* ignore */ } }, timeoutMs);
      let buf = "";
      const handle = (o: any) => {
        const type = o?.type;
        const part = o?.part ?? {};
        if (type === "tool_use" || type === "tool") {
          const name = part?.tool || o?.tool || part?.name;
          const input = part?.state?.input ?? o?.state?.input ?? {};
          const detail = input.command || input.filePath || input.pattern || "";
          if (name) log(`planner · ${name}${detail ? " " + String(detail).slice(0, 70) : ""}`);
        } else if (type === "text" || type === "message" || part?.type === "text") {
          // Accumulate ALL assistant text (not just the last event): the JSON may be
          // followed by narration, and event shapes vary across opencode versions.
          const text = part?.text ?? o?.text ?? part?.content;
          if (typeof text === "string" && text.trim()) { finalText += text + "\n"; log(`planner · ${text.trim().replace(/\s+/g, " ").slice(0, 120)}`); }
        } else if (type === "error") {
          log(`planner error: ${o?.error?.data?.message || o?.error?.name || "opencode error"}`);
        }
      };
      p.stdout.on("data", (d: Buffer) => { buf += d.toString(); let nl; while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) { try { handle(JSON.parse(line)); } catch { /* noise */ } } } });
      p.stderr.on("data", (d: Buffer) => { const l = d.toString().trim(); if (l) log(`planner: ${l.slice(0, 120)}`); });
      p.on("error", (e) => { log(`planner spawn failed: ${e.message}`); clearTimeout(killer); resolve(); });
      p.on("close", () => { clearTimeout(killer); resolve(); });
    });
    // Primary: the plan the agent WROTE to plan.json (robust — no dependence on the
    // event-stream shape). Fallback: whatever JSON we can find in its chat text.
    if (existsSync(planPath)) { try { fileText = readFileSync(planPath, "utf8"); } catch { /* fall back to text */ } }
  } finally {
    try { rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(dataHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const plan = extractPlan(fileText) || extractPlan(finalText);
  if (!plan) throw new Error("planner produced no usable JSON plan");
  if (!plan.static && !plan.run) throw new Error("planner returned no run command for a server app");
  log(`planner · ${plan.language}${plan.static ? " (static)" : ""}${plan.needsDB ? " +db" : ""} → ${plan.static ? plan.outputDir : plan.run}`);
  return plan;
}

export async function opencodeRepair(opts: {
  dir: string;              // the repo copy the agent edits (same as repairDeploy)
  slug: string;
  initialError: string;
  redeploy: Redeploy;
  log: (l: string) => void;
}): Promise<RepairResult> {
  const { dir, slug, initialError, redeploy, log } = opts;
  const tokens: TokenUsage = { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  const changes = new Set<string>();
  let steps = 0, redeploys = 0;

  // Bridge: opencode's redeploy.sh POSTs here; we run the real pipeline. Capped so
  // a wandering agent can't burn unbounded cloud builds.
  let lastUrl: string | undefined;
  // A real redeploy (a full cloud build) outlives opencode's bash-tool timeout, so
  // opencode kills redeploy.sh mid-build and retries — which must NOT kick off a
  // second concurrent build (two builds racing on one slug can leave the release
  // pointer on an incomplete one). Dedupe: while a redeploy is in flight, later
  // calls attach to the SAME promise and get its real result.
  let inFlight: Promise<{ ok: boolean; url?: string; error?: string }> | null = null;
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/redeploy") { res.writeHead(404); res.end(); return; }
    const reply = (r: { ok: boolean; url?: string; error?: string }) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(r));
    };
    if (inFlight) { inFlight.then(reply).catch((e) => reply({ ok: false, error: String(e) })); return; }
    if (redeploys >= MAX_REDEPLOYS) { reply({ ok: false, error: "redeploy limit reached — stop and report what is blocking" }); return; }
    redeploys++;
    log(`agent · redeploying (attempt ${redeploys})…`);
    inFlight = redeploy();
    inFlight.then((r) => {
      inFlight = null;
      if (r.ok) { lastUrl = r.url; log(`agent · redeploy succeeded`); } else { log(`agent · still failing, iterating`); }
      reply(r);
    }).catch((e) => {
      inFlight = null;
      reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;

  // opencode must NOT run with the repo itself as cwd — session/message creation
  // fails ("createUserMessage → UnknownError") when cwd is a populated repo. Run it
  // in a clean wrapper with the repo symlinked as ./repo; edits there land in `dir`,
  // which is exactly what `redeploy` (runDeploy) rebuilds.
  const ws = mkdtempSync(join(tmpdir(), "ss-oc-"));
  // Data dir OUTSIDE the workspace: opencode scans cwd, and its own db folder under
  // cwd trips up session bootstrap.
  const dataHome = mkdtempSync(join(tmpdir(), "ss-ocdata-"));
  let agentError: string | null = null;
  try {
    symlinkSync(dir, join(ws, "repo"));
    const token = await gcloudToken();
    writeFileSync(join(ws, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      provider: { vertex: { npm: "@ai-sdk/openai-compatible", name: "Vertex Gemini", options: {
        baseURL: `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${LOCATION}/endpoints/openapi`,
        apiKey: token,
      }, models: { "google/gemini-2.5-pro": { name: "Gemini 2.5 Pro" } } } },
    }, null, 2));
    mkdirSync(join(ws, ".opencode", "agent"), { recursive: true });
    writeFileSync(join(ws, ".opencode", "agent", "deploy.md"), AGENT_MD);
    writeFileSync(join(ws, "redeploy.sh"), redeployScript(port));

    const prompt = `The deploy failed with this error:\n\n${initialError}\n\nFix the app in ./repo and run \`bash redeploy.sh\` until it deploys live.`;
    const dbg = process.env.OPENCODE_DEBUG === "1" ? ["--print-logs", "--log-level", "DEBUG"] : [];
    const args = ["run", "--agent", "deploy", "--model", MODEL, "--auto", "--format", "json", ...dbg, prompt];

    await new Promise<void>((resolve) => {
      // Give opencode a clean, explicit environment instead of inheriting the
      // control plane's. Launched under npm + a Next.js/TS runtime, the parent env
      // carries npm_*/NODE_OPTIONS/loader hooks that poison the `node` subprocesses
      // opencode spawns — surfacing only as its opaque "Unexpected server error".
      // An allowlist is robust where blocklisting each offender was not.
      const childEnv: NodeJS.ProcessEnv = {
        NODE_ENV: process.env.NODE_ENV || "production",
        HOME: homedir(),
        // Prepend opencode's own bin; keep the inherited PATH so `node`/`git` resolve
        // on both macOS (dev) and the Linux control-plane image. PATH is not one of
        // the poison vars, so inheriting it is safe.
        PATH: `${join(homedir(), ".opencode", "bin")}:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}`,
        TMPDIR: tmpdir(),
        LANG: process.env.LANG || "en_US.UTF-8",
        USER: process.env.USER || "supersonic",
        SS_REDEPLOY_PORT: String(port),
        // Per-run data dir: opencode keeps sessions in a shared SQLite db under
        // XDG_DATA_HOME, and concurrent deploys racing on it fail message creation.
        // Isolating it makes each deploy hermetic.
        XDG_DATA_HOME: dataHome,
      };
      const p = spawn(opencodeBin(), args, {
        cwd: ws,
        // stdin closed: `opencode run --format json` blocks on stdin EOF otherwise.
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
      });
      let buf = "";
      const handle = (o: any) => {
        const type = o?.type;
        const part = o?.part ?? {};
        if (type === "step_finish") {
          steps++;
          const t = part?.tokens;
          if (t) { tokens.total += t.total ?? 0; tokens.input += t.input ?? 0; tokens.output += t.output ?? 0; tokens.reasoning += t.reasoning ?? 0; tokens.cacheRead += t.cache?.read ?? 0; tokens.cacheWrite += t.cache?.write ?? 0; }
        } else if (type === "tool_use" || type === "tool") {
          const name = part?.tool || o?.tool || part?.name;
          const input = part?.state?.input ?? o?.state?.input ?? {};
          if (name === "edit" || name === "write") { const f = input.filePath; if (f) changes.add(String(f).replace(/^.*?\/repo\//, "").replace(/^repo\//, "")); }
          const detail = input.command || input.filePath || input.pattern || "";
          if (name && name !== "redeploy") log(`agent · ${name}${detail ? " " + String(detail).slice(0, 70) : ""}`);
        } else if (type === "text") {
          const text = part?.text ?? o?.text;
          if (typeof text === "string") { const line = text.trim().replace(/\s+/g, " "); if (line) log(`agent · ${line.slice(0, 160)}`); }
        } else if (type === "error") {
          agentError = o?.error?.data?.message || o?.error?.name || "opencode error";
          log(`opencode error: ${agentError}`);
        }
      };
      p.stdout.on("data", (d: Buffer) => { buf += d.toString(); let nl; while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) { try { handle(JSON.parse(line)); } catch { /* noise */ } } } });
      p.stderr.on("data", (d: Buffer) => { const l = d.toString().trim(); if (l) log(`opencode: ${l.slice(0, 160)}`); });
      p.on("error", (e) => { agentError = e.message; log(`opencode spawn failed: ${e.message}`); resolve(); });
      p.on("close", () => resolve());
    });
  } finally {
    server.close();
    if (process.env.OPENCODE_KEEP_WS === "1") { log(`kept ws: ${ws}`); }
    else {
      try { rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
      try { rmSync(dataHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // Ground truth: the pipeline's own success, not the agent's prose. redeploy.sh
  // writes .deploy.result next to itself (the wrapper) — but the wrapper is gone by
  // now, so trust the last successful redeploy the bridge recorded.
  const ok = !!lastUrl;
  const url = lastUrl;
  log(`tokens · total ${tokens.total} (in ${tokens.input} / out ${tokens.output} / reasoning ${tokens.reasoning} / cacheRead ${tokens.cacheRead}) · ${steps} steps · ${redeploys} redeploys`);
  return {
    ok, url, changes: [...changes], steps, redeploys, tokens,
    summary: ok ? `Fixed via opencode: ${[...changes].join(", ") || "config"}` : `opencode couldn't get it live after ${redeploys} redeploys`,
  };
}
