export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudRunName } from "@/lib/slug";
import { repairDeploy } from "@/lib/agent";
import { currentUserId } from "@/lib/session";
import { pgConfig } from "@/lib/pg-config";
import { resolveSlug } from "@/lib/gcloud";
import { setDeploy } from "@/lib/deploys";

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
  let cfg;
  try { cfg = pgConfig(); } catch (e) { return Promise.reject(e); }
  const dbName = slug.replace(/-/g, "_").slice(0, 60);
  return capture("gcloud", ["sql", "databases", "create", dbName, "--instance=supersonic-shared-pg", "--project", PROJECT])
    .catch((e: Error) => { if (/already exists/i.test(e.message)) return ""; throw e; })
    .then(() => {
      log(`Provisioned Postgres database ${dbName}`);
      const databaseUrl = `postgresql://${cfg.user}:${cfg.password}@/${dbName}?host=/cloudsql/${cfg.connectionName}`;
      return { databaseUrl, connectionName: cfg.connectionName };
    });
}

/** Create a per-app GCS bucket (idempotent) and return its name. */
async function provisionStorage(slug: string, log: (l: string) => void): Promise<string> {
  const bucket = `supersonicdeploy-${slug}`.slice(0, 63);
  try {
    await capture("gcloud", ["storage", "buckets", "create", `gs://${bucket}`, "--location", REGION, "--project", PROJECT]);
    log(`Provisioned storage bucket ${bucket}`);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (!/already own|already exists|conflict|409/i.test(m)) throw e;
  }
  return bucket;
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

// A failed `gcloud run deploy --source` only says "Build failed; check logs".
// Pull the actual Cloud Build output so the repair agent fixes the real error.
async function fetchBuildError(): Promise<string> {
  try {
    const list = await capture("gcloud", ["builds", "list", "--region", REGION, "--project", PROJECT, "--limit", "1", "--format=value(id)"]);
    const id = list.trim().split("\n")[0];
    if (!id) return "";
    const raw = await capture("gcloud", ["beta", "builds", "log", id, "--region", REGION, "--project", PROJECT]);
    const lines = raw.split("\n").map((l) => l.replace(/^Step #\d+ - "[^"]*":\s?/, "").replace(/\r/g, "").trimEnd()).filter((l) => l.trim());
    const errs = lines.filter((l) => /error|fail|not found|cannot|npm ERR|\berror TS\d|Error:|exit code|Module not found|ENOENT|EACCES|SyntaxError|TypeError|denied/i.test(l));
    return (errs.length ? errs : lines).slice(-30).join("\n");
  } catch {
    return "";
  }
}

// SPAs (Vite/CRA) are static sites, not servers. Build them and serve the
// output on $PORT instead of trying to run a dev/preview server.
function spaDockerfile(outdir: string): string {
  return [
    "FROM node:22-slim AS build",
    "WORKDIR /app",
    "COPY package*.json ./",
    "RUN npm install",
    "COPY . .",
    "RUN npm run build",
    "",
    "FROM node:22-slim",
    "WORKDIR /app",
    "RUN npm install -g serve",
    `COPY --from=build /app/${outdir} ./public`,
    "ENV PORT=8080",
    "EXPOSE 8080",
    'CMD ["sh","-c","serve -s public -l ${PORT}"]',
    "",
  ].join("\n");
}

// Next.js (and other build-then-serve node frameworks) MUST run their build
// before `next start`, or the container crashloops with "no production build in
// .next". Buildpacks don't reliably run the build (esp. with mixed lockfiles),
// so we inject an explicit build -> start Dockerfile. Forcing `npm install` also
// resolves the classic package-lock.json + yarn.lock ambiguity.
function nextDockerfile(): string {
  return [
    "FROM node:22-slim AS build",
    "WORKDIR /app",
    "ENV NEXT_TELEMETRY_DISABLED=1",
    "COPY package*.json ./",
    "RUN npm install --no-audit --no-fund --legacy-peer-deps",
    "COPY . .",
    "RUN npm run build",
    "",
    "FROM node:22-slim",
    "WORKDIR /app",
    "ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080",
    "COPY --from=build /app ./",
    "EXPOSE 8080",
    'CMD ["npm","run","start"]',
    "",
  ].join("\n");
}

// File-based detection (more reliable than a framework label): a Next.js app has
// `next` in its deps and a build script.
function isNextApp(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return Boolean(deps.next) && Boolean(pkg.scripts?.build);
  } catch {
    return false;
  }
}

// Kaniko build with registry layer caching + a fast build machine. Caches each
// layer (crucially the `npm install` layer) keyed on the files it depends on, so
// an unchanged package.json means deps are pulled from cache instead of rebuilt.
function cachedBuildConfig(image: string): string {
  return [
    "steps:",
    "  - name: gcr.io/kaniko-project/executor:latest",
    "    args:",
    `      - --destination=${image}:latest`,
    "      - --dockerfile=Dockerfile",
    "      - --cache=true",
    "      - --cache-ttl=168h",
    `      - --cache-repo=${image}-cache`,
    "      - --snapshot-mode=redo",
    "      - --use-new-run",
    "options:",
    "  machineType: E2_HIGHCPU_8",
    "  logging: CLOUD_LOGGING_ONLY",
    "",
  ].join("\n");
}

// Give the app a <slug>.supersonic.cv address (the wildcard *.supersonic.cv
// CNAME + this per-app mapping is what routes it). SSL provisions async.
async function createDomainMapping(slug: string, log: (l: string) => void): Promise<void> {
  try {
    await capture("gcloud", ["beta", "run", "domain-mappings", "create", "--service", slug, "--domain", `${slug}.supersonic.cv`, "--region", REGION, "--project", PROJECT]);
    log(`Mapped ${slug}.supersonic.cv (SSL provisioning, live in ~15 min)`);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/already exists/i.test(m)) { log(`${slug}.supersonic.cv already mapped`); return; }
    log(`! custom domain skipped: ${m.replace(/\s+/g, " ").slice(0, 100)}`);
  }
}

export async function POST(req: Request) {
  const ownerId = await currentUserId();
  // Two ingest doors: a git URL (clone) or a project uploaded straight from the
  // user's computer (a gzipped tar of the folder). Both end in a populated dir,
  // after which the pipeline is identical.
  const isUpload = req.headers.get("x-supersonic-upload") === "1";
  let url = "";
  let slug = "";
  let friendlyName = "app";
  let secrets: Record<string, string> = {};
  let archive: Buffer | null = null;
  if (isUpload) {
    archive = Buffer.from(await req.arrayBuffer());
    friendlyName = cloudRunName(req.headers.get("x-supersonic-app") || "app");
  } else {
    const body = await req.json().catch(() => ({}));
    url = normalizeRepo(String(body.repo ?? ""));
    friendlyName = cloudRunName(url);
    secrets = (body.secrets ?? {}) as Record<string, string>;
  }
  // Apps get a short random subdomain (e.g. as76d.supersonic.cv). Redeploys reuse
  // the same slug by matching the friendly name against the user's existing apps.
  slug = await resolveSlug(ownerId || "", friendlyName);

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (o: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
      let lastStage = 0;
      const log = (line: string) => {
        send({ type: "log", line });
        // Mirror progress to the deploy store (throttled) so the dashboard sees it live.
        if (ownerId && Date.now() - lastStage > 2500) { lastStage = Date.now(); setDeploy(slug, { status: "building", stage: line }); }
      };
      try {
        send({ type: "start", slug, url: url || `${slug} · from your computer` });
        if (ownerId) setDeploy(slug, { ownerId, name: friendlyName, status: "building", stage: "starting…" });
        const dir = mkdtempSync(join(tmpdir(), "ss-deploy-"));

        if (isUpload && archive) {
          log("Unpacking your project…");
          const tgz = `${dir}.tgz`;
          writeFileSync(tgz, archive);
          await run("tar", ["-xzf", tgz, "-C", dir], () => {});
        } else {
          log(`Pulling ${url}`);
          await run("git", ["clone", "--depth", "1", url, dir], () => {});
        }

        log("Detecting stack…");
        const raw = await capture("npm", ["--prefix", AGENT, "run", "detect", "--silent", "--", dir, "--api"]);
        const det = JSON.parse(raw.slice(raw.indexOf("{")));
        const s = det.stack;
        send({ type: "detected", stack: s, plan: det.provisionPlan });
        log(`Detected ${s.framework} · ${s.language} (${Math.round(s.confidence * 100)}%)`);
        if (s.database?.engine) log(`Provision ${s.database.engine} (via ${s.database.via})`);
        if (s.cache) log(`Provision ${s.cache} cache`);
        if (s.secretsNeeded?.length) log(`Will ask for secrets: ${s.secretsNeeded.join(", ")}`);

        const hasDockerfile = existsSync(join(dir, "Dockerfile"));
        if (!hasDockerfile && /vite|create react app|\bspa\b/i.test(s.framework)) {
          const outdir = /create react app/i.test(s.framework) ? "build" : "dist";
          writeFileSync(join(dir, "Dockerfile"), spaDockerfile(outdir));
          log(`SPA detected — building to static and serving ${outdir}/ on $PORT`);
        } else if (!hasDockerfile && isNextApp(dir)) {
          writeFileSync(join(dir, "Dockerfile"), nextDockerfile());
          log("Next.js detected — running the build, then serving on $PORT");
        }

        const extraEnv: string[] = url ? [`SUPERSONIC_REPO=${url}`] : [];
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

        log("Provisioning object storage…");
        try {
          const bucket = await provisionStorage(slug, log);
          extraEnv.push(`STORAGE_BUCKET=${bucket}`);
          extraEnv.push(`GOOGLE_CLOUD_PROJECT=${PROJECT}`);
        } catch (e) {
          log(`! storage skipped: ${e instanceof Error ? e.message : String(e)}`);
        }

        for (const [k, v] of Object.entries(secrets)) {
          if (k && v) { extraEnv.push(`${k}=${v}`); log(`Injecting secret ${k}`); }
        }

        // Flags shared by both build paths (applied on `gcloud run deploy`).
        const deployFlags = [
          "--region", REGION, "--allow-unauthenticated",
          "--project", PROJECT, "--format=json",
        ];
        if (cloudsql) deployFlags.push(`--set-cloudsql-instances=${cloudsql}`);
        if (extraEnv.length) deployFlags.push(`--set-env-vars=^~~^${extraEnv.join("~~")}`);
        const labelPairs: string[] = [`supersonic-name=${friendlyName}`];
        if (ownerId) labelPairs.push(`supersonic-owner=${ownerId}`);
        deployFlags.push(`--update-labels=${labelPairs.join(",")}`);

        // With a Dockerfile, build via Kaniko (registry layer cache + a fast build
        // machine) and deploy the image — so an unchanged `npm install` is reused and
        // redeploys are dramatically faster. Without one, fall back to buildpacks.
        const IMAGE = `${REGION}-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy/${slug}`;
        const useKaniko = existsSync(join(dir, "Dockerfile"));
        if (useKaniko) writeFileSync(join(dir, "cloudbuild.yaml"), cachedBuildConfig(IMAGE));
        const buildLine = (l: string) => { if (/error|fail|step #|npm |next build|compiled|pushing|using cache|cached|denied|warming/i.test(l)) log(l); };

        const attempt = async (args: string[]): Promise<{ ok: boolean; url?: string; error?: string }> => {
          const hb = setInterval(() => log("deploying…"), 6000);
          try {
            const o = await gcloudDeploy(args, log);
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
            let err = e instanceof Error ? e.message : String(e);
            if (/build failed/i.test(err)) {
              log("fetching the real build log for the agent…");
              const buildLog = await fetchBuildError();
              if (buildLog) err = `Cloud Build failed. Actual build output:\n${buildLog}`;
            }
            return { ok: false, error: err };
          }
        };
        const runDeploy = async (): Promise<{ ok: boolean; url?: string; error?: string }> => {
          if (useKaniko) {
            log("Building with layer cache — the first build warms it, later ones are fast…");
            const hb = setInterval(() => log("building…"), 8000);
            const btail: string[] = [];
            const onBuild = (l: string) => { btail.push(l); if (btail.length > 60) btail.shift(); buildLine(l); };
            try {
              await run("gcloud", ["builds", "submit", dir, "--region", REGION, "--project", PROJECT, "--config", join(dir, "cloudbuild.yaml")], onBuild);
            } catch {
              clearInterval(hb);
              const buildLog = await fetchBuildError();
              const reason = buildLog
                || btail.filter((l) => /error|invalid|denied|must|logging|permission|quota|not found/i.test(l)).slice(-6).join("\n")
                || btail.slice(-6).join("\n");
              return { ok: false, error: reason ? `Build failed:\n${reason}` : "the build failed — check the logs" };
            }
            clearInterval(hb);
            return attempt(["run", "deploy", slug, "--image", `${IMAGE}:latest`, ...deployFlags]);
          }
          let res = await attempt(["run", "deploy", slug, "--source", dir, ...deployFlags]);
          if (!res.ok && /clear-base-image/i.test(res.error ?? "")) {
            log("switching build type — clearing base image and retrying…");
            res = await attempt(["run", "deploy", slug, "--source", dir, ...deployFlags, "--clear-base-image"]);
          }
          return res;
        };

        log(`Deploying ${slug} to Cloud Run…`);
        let result = await runDeploy();
        if (!result.ok) {
          log(`✕ ${result.error}`);
          log("Repair agent taking over — reading the repo, fixing, retrying…");
          const fixed = await repairDeploy({ dir, slug, initialError: result.error ?? "unknown", redeploy: runDeploy, log });
          if (fixed.ok) { result = { ok: true, url: fixed.url }; log(`Agent fixed it (${fixed.changes.join(", ")})`); }
          else { if (ownerId) setDeploy(slug, { status: "failed", stage: fixed.summary }); send({ type: "error", message: fixed.summary }); return; }
        }
        log(`Live at ${result.url}`);
        await createDomainMapping(slug, log);
        if (ownerId) setDeploy(slug, { status: "live", url: result.url });
        send({ type: "done", slug, url: result.url });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (ownerId) setDeploy(slug, { status: "failed", stage: msg });
        send({ type: "error", message: msg });
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
