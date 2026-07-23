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

const PROJECT = "supersonic-deploy-prod";
const LOCATION = "us-central1";
const MODEL = "gemini-2.5-flash";
const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH ?? ""}` } as NodeJS.ProcessEnv;

let cachedToken: { value: string; at: number } | null = null;
function getToken(): Promise<string> {
  if (cachedToken && Date.now() - cachedToken.at < 45 * 60_000) return Promise.resolve(cachedToken.value);
  return new Promise((res, rej) => {
    const p = spawn("gcloud", ["auth", "print-access-token"], { env: ENV });
    let out = "", err = "";
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.stderr.on("data", (d: Buffer) => (err += d));
    p.on("close", (c) => (c === 0 ? (cachedToken = { value: out.trim(), at: Date.now() }, res(out.trim())) : rej(new Error(err.trim() || "token failed"))));
  });
}

async function gemini(body: unknown): Promise<any> {
  const token = await getToken();
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
  const r = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
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

const TOOLS = [
  { name: "list_files", description: "List the repo's files.", parameters: { type: "object", properties: {} } },
  { name: "read_file", description: "Read a file's contents.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Create or overwrite a file with new contents.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "redeploy", description: "Redeploy to Cloud Run and return the result. Slow (~2 min). Call after making changes.", parameters: { type: "object", properties: {} } },
  { name: "give_up", description: "Stop and tell the user exactly what they must fix themselves (e.g. a required secret).", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } },
];

const SYSTEM = `You are Supersonic's deployment repair agent. A vibe-coded app failed to deploy to Google Cloud Run. Your ONLY goal is to make it deploy successfully and serve HTTP on the port given by the PORT environment variable (Cloud Run sets PORT, usually 8080).

Guidance:
- Make minimal, targeted changes to the repo files.
- The most common failure: the app listens on a hardcoded port instead of process.env.PORT. Fix it to read process.env.PORT (keep the old port as a fallback).
- Other fixes: pin a supported runtime (Node >= 22), add/correct the start script, add a minimal Dockerfile only if buildpacks can't handle it, ensure a build step exists.
- After each change call redeploy. If it succeeds, stop.
- If the app truly cannot run without external secrets/services you cannot provide (a required API key, a database URL you don't have), call give_up with a precise, copy-pasteable instruction for the user's own coding agent.
- If the repo is a library/SDK/CLI with no web server entrypoint (e.g. a Python package with only setup.py/pyproject and no Flask/FastAPI/Django, or an npm library with no server), do NOT add a web server or redeploy — immediately call give_up explaining it is not a deployable web app.
- If a Vite/Vue/React app is up but rejects the request with "Blocked request"/"allowedHosts", fix it: set preview.allowedHosts and server.allowedHosts to true in vite.config, and make the start/preview command bind 0.0.0.0 and use $PORT (or build to static and serve the dist output).
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
