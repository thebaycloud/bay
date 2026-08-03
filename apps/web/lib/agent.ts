/**
 * Supersonic repair agent — a Gemini tool-use loop that makes a failed repo deploy.
 * Given the repo dir + the deploy error, it reads/edits files and redeploys until
 * the container comes up on $PORT — or gives up with a precise fix-prompt.
 *
 * Runs on Vertex AI Gemini via the gcloud access token (no separate API key).
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { accessToken as restAccessToken, invalidateToken } from "./gcp-rest";

const PROJECT = "supersonic-deploy-prod";
const LOCATION = "us-central1";
const MODEL = "gemini-2.5-pro";
const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH ?? ""}` } as NodeJS.ProcessEnv;

/**
 * Shared cache first (metadata server on Cloud Run, gcloud locally), own spawn
 * second. The local cache below is only reached when the shared one could not
 * answer, and is deliberately short: `gcloud auth print-access-token` reports no
 * expiry and hands back a disk-cached token that may have only minutes of life
 * left, so trusting one for 45 minutes could serve an already-dead token.
 */
let cachedToken: { value: string; at: number } | null = null;
async function getToken(): Promise<string> {
  const shared = await restAccessToken();
  if (shared) return shared;
  if (cachedToken && Date.now() - cachedToken.at < 10 * 60_000) return cachedToken.value;
  return new Promise<string>((res, rej) => {
    const p = spawn("gcloud", ["auth", "print-access-token"], { env: ENV });
    let out = "", err = "";
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.stderr.on("data", (d: Buffer) => (err += d));
    // Without this, a missing gcloud binary is an unhandled 'error' event, which
    // takes the process down instead of failing this one call.
    p.on("error", rej);
    p.on("close", (c) => (c === 0 ? (cachedToken = { value: out.trim(), at: Date.now() }, res(out.trim())) : rej(new Error(err.trim() || "token failed"))));
  });
}

async function gemini(body: unknown): Promise<any> {
  const token = await getToken();
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
  const r = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  // The shared cache is consulted directly here rather than through gcp-rest's
  // `authed()`, so a token the server has rejected has to be dropped by hand or
  // every later call in this process re-sends it until its stated expiry.
  if (r.status === 401 || r.status === 403) invalidateToken();
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j;
}

function safe(dir: string, p: string): string {
  const abs = resolve(dir, p);
  if (!abs.startsWith(resolve(dir))) throw new Error("path escapes repo");
  return abs;
}
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3 || out.length > 200) return;
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const name of names) {
      if (["node_modules", ".git", "dist", "build", ".next"].includes(name)) continue;
      const full = join(d, name);
      const rel = relative(dir, full);
      try {
        if (statSync(full).isDirectory()) { out.push(rel + "/"); walk(full, depth + 1); }
        else out.push(rel);
      } catch { /* ignore */ }
    }
  };
  walk(dir, 0);
  return out.slice(0, 200);
}

const ALLOWED_CMD = /^(npm|npx|pnpm|yarn|node|tsc|corepack)\b/;
function runCommand(dir: string, command: string): Promise<string> {
  return new Promise((resolve) => {
    const cmd = command.trim();
    if (!ALLOWED_CMD.test(cmd)) { resolve("refused: only npm / npx / pnpm / yarn / node / tsc commands are allowed"); return; }
    const p = spawn(cmd, { cwd: dir, env: ENV, shell: true, timeout: 240000 });
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.stderr.on("data", (d: Buffer) => (out += d));
    p.on("error", (e) => resolve("error: " + e.message));
    p.on("close", (code) => resolve(`exit ${code}\n${out.slice(-4000)}`));
  });
}

const TOOLS = [
  { name: "list_files", description: "List the repo's files.", parameters: { type: "object", properties: {} } },
  { name: "read_file", description: "Read a file's contents.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Create or overwrite a file with new contents.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "run_command", description: "Run a shell command inside the repo (only npm / npx / pnpm / yarn / node / tsc). Use 'npm install' to regenerate a broken/out-of-sync lockfile — the usual fix for npm ci errors. Returns exit code + output.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "redeploy", description: "Redeploy to Cloud Run and return the result. Slow (~2 min). Call after making changes.", parameters: { type: "object", properties: {} } },
  { name: "give_up", description: "Stop and tell the user exactly what they must fix themselves (e.g. a required secret).", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } },
];

const SYSTEM = `You are Supersonic's deployment repair agent. A vibe-coded app failed to deploy to Google Cloud Run. Your ONLY goal is to make it deploy successfully and serve HTTP on the port given by the PORT environment variable (Cloud Run sets PORT, usually 8080).

Guidance:
- NEVER create an application that was not already there. Do not write a new entrypoint, a new server, or new source files to make the deploy go green. You are repairing someone's app, not supplying one. Given a repo whose container exited immediately, an agent once wrote main.py, requirements.txt, index.html and a Dockerfile and reported success — so the URL served an app its owner had never written, under their name, and every log line downstream called it a win. A deploy that fails honestly is far better. If the only fix you can see is to write the app, call give_up and say exactly that.
- Do NOT change how the app is served. Do not convert a static site into a server or a server into a static site, and do not swap in a different web server. That routing was decided from a reading of the whole repo; changing it here turns one broken thing into a differently broken thing.
- Make minimal, targeted changes to the repo files.
- The most common failure: the app listens on a hardcoded port instead of process.env.PORT. Fix it to read process.env.PORT (keep the old port as a fallback).
- Other fixes: pin a supported runtime (Node >= 22), add/correct the start script, add a minimal Dockerfile only if buildpacks can't handle it, ensure a build step exists.
- After each change call redeploy. If it succeeds, stop.
- If the app truly cannot run without external secrets/services you cannot provide (a required API key, a database URL you don't have), call give_up with a precise, copy-pasteable instruction for the user's own coding agent.
- If the repo is a library/SDK/CLI with no web server entrypoint (e.g. a Python package with only setup.py/pyproject and no Flask/FastAPI/Django, or an npm library with no server), do NOT add a web server or redeploy — immediately call give_up explaining it is not a deployable web app.
- If a Vite/Vue/React app is up but rejects the request with "Blocked request"/"allowedHosts", fix it: set preview.allowedHosts and server.allowedHosts to true in vite.config, and make the start/preview command bind 0.0.0.0 and use $PORT (or build to static and serve the dist output).
- You can run shell commands with run_command (only npm / npx / pnpm / yarn / node / tsc). To fix an "npm ci" failure from an out-of-sync or missing lockfile, run "npm install" to regenerate package-lock.json. NEVER hand-edit lockfiles (package-lock.json, yarn.lock, pnpm-lock.yaml) — always regenerate them with the package manager.
- Act only through tools. Do not emit prose.`;

export async function repairDeploy(opts: {
  dir: string;
  slug: string;
  initialError: string;
  redeploy: () => Promise<{ ok: boolean; url?: string; error?: string }>;
  log: (l: string) => void;
}): Promise<{ ok: boolean; url?: string; changes: string[]; summary: string }> {
  const { dir, initialError, redeploy, log } = opts;
  const changes: string[] = [];
  const contents: any[] = [{
    role: "user",
    parts: [{ text: `The deploy failed with this error:\n\n${initialError}\n\nRepo files:\n${listFiles(dir).join("\n")}\n\nDiagnose the cause, fix the files, and redeploy.` }],
  }];
  let redeploys = 0;
  const MAX_STEPS = 18, MAX_REDEPLOYS = 3;

  for (let step = 0; step < MAX_STEPS; step++) {
    let resp: any;
    try {
      resp = await gemini({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents,
        tools: [{ functionDeclarations: TOOLS }],
        toolConfig: { functionCallingConfig: { mode: "ANY" } },
        generationConfig: { temperature: 0 },
      });
    } catch (e) {
      return { ok: false, changes, summary: `Repair agent error: ${e instanceof Error ? e.message : String(e)}` };
    }

    const parts: any[] = resp.candidates?.[0]?.content?.parts ?? [];
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    if (!calls.length) {
      contents.push({ role: "model", parts });
      contents.push({ role: "user", parts: [{ text: "Use a tool. Call redeploy when ready." }] });
      continue;
    }

    contents.push({ role: "model", parts });
    const responses: any[] = [];
    for (const call of calls) {
      const name: string = call.name;
      const args = call.args ?? {};
      let result = "";
      try {
        if (name === "list_files") result = listFiles(dir).join("\n");
        else if (name === "read_file") { result = readFileSync(safe(dir, args.path), "utf8").slice(0, 8000); log(`agent · read ${args.path}`); }
        else if (name === "write_file") { writeFileSync(safe(dir, args.path), args.content ?? ""); changes.push(args.path); log(`agent · patched ${args.path}`); result = "written"; }
        else if (name === "run_command") { log(`agent · run ${String(args.command || "").slice(0, 60)}`); result = await runCommand(dir, String(args.command || "")); }
        else if (name === "give_up") { log(`agent · handing back to you`); return { ok: false, changes, summary: args.reason ?? "needs manual fix" }; }
        else if (name === "redeploy") {
          if (redeploys >= MAX_REDEPLOYS) { result = "redeploy limit reached — call give_up"; }
          else {
            redeploys++;
            log(`agent · redeploying (attempt ${redeploys})…`);
            const r = await redeploy();
            if (r.ok) { log(`agent · redeploy succeeded`); return { ok: true, url: r.url, changes, summary: `Fixed: ${changes.join(", ") || "config"}` }; }
            result = `redeploy failed: ${r.error}`;
            log(`agent · still failing, iterating`);
          }
        } else result = "unknown tool";
      } catch (e) {
        result = `error: ${e instanceof Error ? e.message : String(e)}`;
      }
      responses.push({ functionResponse: { name, response: { result: String(result) } } });
    }
    contents.push({ role: "user", parts: responses });
  }

  return { ok: false, changes, summary: `Couldn't fix it automatically after ${redeploys} redeploys${changes.length ? ` (tried: ${changes.join(", ")})` : ""}. Open it in your coding agent to debug.` };
}

// ---- diagnose-only (the maintenance loop): produce a fix-prompt, never edit ----

const DIAGNOSE_TOOLS = [
  { name: "list_files", description: "List the repo's files.", parameters: { type: "object", properties: {} } },
  { name: "read_file", description: "Read a file's contents.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "report_fix", description: "Return the final, surgical fix-prompt for the user's own coding agent.", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } },
];

const DIAGNOSE_SYSTEM = `You are Supersonic's diagnosis assistant. A deployed app is throwing an error in production. Read the relevant repo files, then produce a SHORT, surgical fix-prompt the user can paste into their own coding agent (e.g. Claude Code) to fix it — reference the exact file(s), line(s), and the change to make. Do NOT rewrite whole files or edit anything. When ready, call report_fix with the prompt. Act only through tools.`;

export async function diagnoseError(opts: { dir?: string; error: string; about?: Record<string, unknown> }): Promise<string> {
  const { dir, error, about } = opts;
  // WITH the source when there is any, and usefully without it when there is not.
  //
  // `dir` was required, and both callers got it by cloning `svc.repo` — which is
  // set only when the deploy had a git URL. The default deploy is a folder upload
  // from somebody's machine, so the endpoints this powers answered 400 to the
  // majority of apps: "no source repo on file", for an app that had deployed
  // perfectly well.
  //
  // Without the files the model cannot read code, and it can still do the thing
  // that is actually being asked — turn a production error into a sentence the
  // owner's own coding agent can act on — given what the platform knows about the
  // app. That is strictly better than a 400, and it is honest about which it is
  // doing rather than pretending to have read a repository.
  const known = about && Object.keys(about).length
    ? `\n\nWhat the platform knows about this app:\n${JSON.stringify(about, null, 2)}`
    : "";
  const source = dir
    ? `\n\nRepo files:\n${listFiles(dir).join("\n")}\n\nRead what you need, then call report_fix with a precise fix-prompt.`
    : `${known}\n\nYou do NOT have the source for this app — do not call read_file, and do not guess at file contents.`
      + ` Write a fix-prompt the owner can hand to their own coding agent, which DOES have the code:`
      + ` say what the error means, the most likely cause, and exactly what to change. Then call report_fix.`;
  const contents: any[] = [{
    role: "user",
    parts: [{ text: `Production error:\n\n${error}${dir ? known : ""}${source}` }],
  }];
  for (let step = 0; step < 10; step++) {
    let resp: any;
    try {
      resp = await gemini({
        systemInstruction: { parts: [{ text: DIAGNOSE_SYSTEM }] },
        contents,
        tools: [{ functionDeclarations: DIAGNOSE_TOOLS }],
        toolConfig: { functionCallingConfig: { mode: "ANY" } },
        generationConfig: { temperature: 0 },
      });
    } catch (e) {
      return `Couldn't diagnose automatically: ${e instanceof Error ? e.message : String(e)}`;
    }
    const parts: any[] = resp.candidates?.[0]?.content?.parts ?? [];
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    if (!calls.length) {
      contents.push({ role: "model", parts });
      contents.push({ role: "user", parts: [{ text: "Call report_fix with the fix-prompt." }] });
      continue;
    }
    contents.push({ role: "model", parts });
    const responses: any[] = [];
    for (const call of calls) {
      const name: string = call.name;
      const args = call.args ?? {};
      let result = "";
      try {
        // A model told it has no source will still sometimes reach for the file
        // tools. Answering plainly beats throwing: it corrects course and writes
        // the prompt, where an error would send it round the loop again.
        if (name === "list_files") result = dir ? listFiles(dir).join("\n") : "no source available for this app";
        else if (name === "read_file") {
          result = dir ? readFileSync(safe(dir, args.path), "utf8").slice(0, 8000) : "no source available for this app";
        }
        else if (name === "report_fix") return String(args.prompt ?? "No fix produced.");
        else result = "unknown tool";
      } catch (e) { result = `error: ${e instanceof Error ? e.message : String(e)}`; }
      responses.push({ functionResponse: { name, response: { result: String(result) } } });
    }
    contents.push({ role: "user", parts: responses });
  }
  return "Couldn't pinpoint the fix automatically — open the app in your coding agent with the error above.";
}
