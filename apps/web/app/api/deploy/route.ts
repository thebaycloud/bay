export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudRunName } from "@/lib/slug";
import { repairDeploy } from "@/lib/agent";

const PROJECT = "supersonic-deploy-prod";
const REGION = "us-central1";
const AGENT = join(process.cwd(), "..", "..", "services", "deploy-agent");
const ENV = {
  ...process.env,
  PATH: `/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH ?? ""}`,
  CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
} as NodeJS.ProcessEnv;

function forEachLine(buf: Buffer, cb: (l: string) => void) {
  buf.toString().split(/\r?\n/).forEach((l) => { if (l.trim()) cb(l.trim()); });
}
function run(cmd: string, args: string[], onLine: (l: string) => void) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { env: ENV });
    p.stdout.on("data", (d: Buffer) => forEachLine(d, onLine));
    p.stderr.on("data", (d: Buffer) => forEachLine(d, onLine));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
  });
}
function capture(cmd: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const p = spawn(cmd, args, { env: ENV });
    let out = "", err = "";
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.stderr.on("data", (d: Buffer) => (err += d));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(err.trim() || `${cmd} exited ${c}`))));
  });
}
function diagnose(errTail: string[]): string {
  const text = errTail.join("\n");
  if (/failed to start and listen on the port/i.test(text)) {
    return "Image built fine, but the container didn't start on $PORT (8080). It most likely needs environment/secrets that aren't set yet (e.g. DATABASE_URL) or listens on a hardcoded port instead of process.env.PORT. Provisioning the database + injecting env is the next step.";
  }
  if (/Node\.js version|resolve version matching/i.test(text)) {
    return "Build failed on an unsupported runtime version — pin a current version (e.g. Node 22).";
  }
  const errs = errTail.filter((l) => /error|fail/i.test(l)).slice(-4);
  return errs.join(" · ") || errTail.slice(-4).join(" · ") || "deploy failed";
}

function gcloudDeploy(args: string[], onLine: (l: string) => void) {
  return new Promise<string>((resolve, reject) => {
    const p = spawn("gcloud", args, { env: ENV });
    let out = "";
    const errTail: string[] = [];
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.stderr.on("data", (d: Buffer) => {
      d.toString().split(/\r?\n/).forEach((raw) => {
        const l = raw.trim();
        if (!l) return;
        errTail.push(l);
        if (errTail.length > 60) errTail.shift();
        if (/fail|error|listen on the port|Revision|Cloud Run error/i.test(l)) onLine(l);
      });
    });
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(diagnose(errTail)))));
  });
}

function normalizeRepo(raw: string): string {
  const r = raw.trim();
  if (r.startsWith("git@") || /^https?:\/\//.test(r) || r.startsWith("file://")) return r;
  if (/^github\.com\//.test(r)) return "https://" + r;
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return "https://github.com/" + r; // owner/repo
  return "https://" + r;
}

/** Create a per-app database on the shared Cloud SQL instance and return a socket DATABASE_URL. */
function provisionPostgres(slug: string, log: (l: string) => void): Promise<{ databaseUrl: string; connectionName: string }> {
  const cfgPath = join(process.cwd(), ".pg.json");
  if (!existsSync(cfgPath)) {
    return Promise.reject(new Error("Shared Postgres isn't ready yet — the instance may still be provisioning."));
  }
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { connectionName: string; user: string; password: string };
  const dbName = slug.replace(/-/g, "_").slice(0, 60);
  return capture("gcloud", ["sql", "databases", "create", dbName, "--instance=supersonic-shared-pg", "--project", PROJECT])
    .catch((e: Error) => { if (/already exists/i.test(e.message)) return ""; throw e; })
    .then(() => {
      log(`Provisioned Postgres database ${dbName}`);
      const databaseUrl = `postgresql://${cfg.user}:${cfg.password}@/${dbName}?host=/cloudsql/${cfg.connectionName}`;
      return { databaseUrl, connectionName: cfg.connectionName };
    });
}

// After a deploy passes Cloud Run's health check, actually fetch the app: a
// server can "listen" yet still reject the real request (e.g. Vite preview host
// allowlisting), which we must catch and repair.
async function probeApp(url: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(to);
    const body = (await r.text()).slice(0, 3000);
    if (r.status >= 500) return { ok: false, reason: `App is up but returns HTTP ${r.status}: ${body.replace(/\s+/g, " ").slice(0, 240)}` };
    if (/blocked request|allowedhosts|is not allowed|cannot get \/|application error|internal server error/i.test(body))
      return { ok: false, reason: `App started but rejected the request: "${body.replace(/\s+/g, " ").slice(0, 240)}"` };
    return { ok: true };
  } catch {
    return { ok: true }; // network/timeout (likely cold start) — don't false-fail
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const url = normalizeRepo(String(body.repo ?? ""));
  const slug = cloudRunName(url);
  const secrets = (body.secrets ?? {}) as Record<string, string>;

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (o: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
      const log = (line: string) => send({ type: "log", line });
      try {
        send({ type: "start", slug, url });
        const dir = mkdtempSync(join(tmpdir(), "ss-deploy-"));

        log(`Pulling ${url}`);
        await run("git", ["clone", "--depth", "1", url, dir], () => {});

        log("Detecting stack…");
        const raw = await capture("npm", ["--prefix", AGENT, "run", "detect", "--silent", "--", dir, "--api"]);
        const det = JSON.parse(raw.slice(raw.indexOf("{")));
        const s = det.stack;
        send({ type: "detected", stack: s, plan: det.provisionPlan });
        log(`Detected ${s.framework} · ${s.language} (${Math.round(s.confidence * 100)}%)`);
        if (s.database?.engine) log(`Provision ${s.database.engine} (via ${s.database.via})`);
        if (s.cache) log(`Provision ${s.cache} cache`);
        if (s.secretsNeeded?.length) log(`Will ask for secrets: ${s.secretsNeeded.join(", ")}`);

        const extraEnv: string[] = [];
        let cloudsql: string | null = null;
        if (s.database?.engine === "postgres") {
          log("Provisioning Postgres…");
          try {
            const pg = await provisionPostgres(slug, log);
            extraEnv.push(`DATABASE_URL=${pg.databaseUrl}`);
            cloudsql = pg.connectionName;
            log("Injecting DATABASE_URL + wiring Cloud SQL");
          } catch (e) {
            log(`! ${e instanceof Error ? e.message : String(e)} — deploying without a database`);
          }
        } else if (s.database?.engine) {
          log(`(${s.database.engine} provisioning not wired yet — deploying without it)`);
        }

        for (const [k, v] of Object.entries(secrets)) {
          if (k && v) { extraEnv.push(`${k}=${v}`); log(`Injecting secret ${k}`); }
        }

        const deployArgs = [
          "run", "deploy", slug, "--source", dir,
          "--region", REGION, "--allow-unauthenticated",
          "--project", PROJECT, "--format=json",
        ];
        if (cloudsql) deployArgs.push(`--set-cloudsql-instances=${cloudsql}`);
        if (extraEnv.length) deployArgs.push(`--set-env-vars=^~~^${extraEnv.join("~~")}`);

        const runDeploy = async (): Promise<{ ok: boolean; url?: string; error?: string }> => {
          const hb = setInterval(() => log("building container…"), 6000);
          try {
            const o = await gcloudDeploy(deployArgs, log);
            clearInterval(hb);
            const svc = JSON.parse(o.slice(o.indexOf("{")));
            const liveUrl = svc?.status?.url ?? "";
            if (liveUrl) {
              log("verifying the app responds…");
              const probe = await probeApp(liveUrl);
              if (!probe.ok) return { ok: false, error: probe.reason };
            }
            return { ok: true, url: liveUrl };
          } catch (e) {
            clearInterval(hb);
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        };

        log(`Deploying ${slug} to Cloud Run…`);
        let result = await runDeploy();
        if (!result.ok) {
          log(`✕ ${result.error}`);
          log("Repair agent taking over — reading the repo, fixing, retrying…");
          const fixed = await repairDeploy({ dir, slug, initialError: result.error ?? "unknown", redeploy: runDeploy, log });
          if (fixed.ok) { result = { ok: true, url: fixed.url }; log(`Agent fixed it (${fixed.changes.join(", ")})`); }
          else { send({ type: "error", message: fixed.summary }); return; }
        }
        log(`Live at ${result.url}`);
        send({ type: "done", slug, url: result.url });
      } catch (e) {
        send({ type: "error", message: e instanceof Error ? e.message : String(e) });
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
