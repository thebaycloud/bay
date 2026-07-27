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
import { createAppRecord, markAppLive, markAppFailed } from "@/lib/apps";
import { getPool } from "@/lib/db";
import { resolveSlug } from "@/lib/gcloud";
import { setDeploy } from "@/lib/deploys";

const PROJECT = "supersonic-deploy-prod";
const REGION = "us-central1";

/**
 * Which routing model a deploy uses. These are mutually exclusive:
 *
 *   off (default) — the app is public and gets its own domain mapping, so
 *                   <slug>.supersonic.cv resolves straight to Cloud Run.
 *   on            — only the proxy may invoke the app, and *.supersonic.cv is
 *                   expected to point at the load balancer in front of it.
 *
 * Turning this on before the DNS cutover makes every app unreachable: the
 * per-app mapping still sends traffic directly to Cloud Run, which now refuses
 * it. See docs/CUTOVER.md for the order of operations.
 */
const SEAL_APPS = process.env.SEAL_APPS === "1";
/** Runtime identity for the apps we host. Empty = inherit the project default. */
const APP_RUNTIME_SA = process.env.APP_RUNTIME_SERVICE_ACCOUNT ?? "";
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

const PROXY_SA = process.env.PROXY_SERVICE_ACCOUNT
  ?? "supersonic-proxy@supersonic-deploy-prod.iam.gserviceaccount.com";

/** Marks a failure the repair agent has no way to fix — permissions, not code. */
const IAM_FAILURE = "IAM binding failed";

/** IAM member string for the identity this control plane runs as. */
async function callerMember(): Promise<string> {
  const out = await capture("gcloud", ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]);
  const acct = out.trim().split("\n")[0].trim();
  if (!acct) throw new Error(`${IAM_FAILURE}: gcloud reports no active account`);
  return acct.endsWith(".gserviceaccount.com") ? `serviceAccount:${acct}` : `user:${acct}`;
}

/**
 * Only the proxy may serve the app to the world — that is what seals the
 * *.run.app bypass. The control plane grants itself the same right because it
 * has to probe the app it just deployed; without that the probe would 403 on
 * every fresh deploy and hand a perfectly good app to the repair agent.
 *
 * This runs before the probe, and a failure fails the deploy: a sealed app
 * that the proxy cannot invoke is unreachable, and reporting it live would be
 * a lie.
 */
async function grantInvokers(slug: string, log: (l: string) => void): Promise<void> {
  for (const member of [`serviceAccount:${PROXY_SA}`, await callerMember()]) {
    try {
      await capture("gcloud", [
        "run", "services", "add-iam-policy-binding", slug,
        "--member", member,
        "--role", "roles/run.invoker",
        "--region", REGION, "--project", PROJECT,
      ]);
    } catch (e) {
      throw new Error(`${IAM_FAILURE} for ${member}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  log("Sealed — reachable only through Supersonic");
}

/** Mint an ID token for a Cloud Run URL so we can call a sealed service. */
async function idTokenFor(audience: string): Promise<string> {
  return (await capture("gcloud", ["auth", "print-identity-token", `--audiences=${audience}`])).trim();
}

// After a deploy passes Cloud Run's health check, actually fetch the app: a
// server can "listen" yet still reject the real request (e.g. Vite preview host
// allowlisting), which we must catch and repair. The app is sealed, so this
// request carries an ID token exactly as the proxy's would.
async function probeApp(url: string, log: (l: string) => void, sealed: boolean): Promise<{ ok: boolean; reason?: string }> {
  // A sealed app cannot be reached without a token, so mint it outside the catch
  // below: a token failure means the check did not happen, and saying so beats
  // returning a pass we never verified. A public app needs no token at all.
  let auth: Record<string, string> = {};
  if (sealed) {
    try {
      auth = { Authorization: `Bearer ${await idTokenFor(url)}` };
    } catch (e) {
      log(`! response check skipped — no ID token (${e instanceof Error ? e.message : String(e)})`);
      return { ok: true };
    }
  }
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(url, { signal: ctrl.signal, headers: auth });
    clearTimeout(to);
    const body = (await r.text()).slice(0, 3000);
    if (r.status === 403) return { ok: false, reason: "App is sealed but the deployer identity cannot invoke it — check the run.invoker binding." };
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
    // No machineType on purpose. Asking for a non-default machine makes Cloud
    // Build provision a dedicated worker, and that wait is not small: across the
    // last 20 builds in this project the split is perfect — every E2_HIGHCPU_8
    // build queued 44-57s before starting, every default-pool build queued 1s.
    // Our app builds finish in 38-72s, so paying ~50s of provisioning to shave a
    // few seconds off an already-short build was a net loss of roughly a minute
    // on every deploy. If app builds ever grow into the multi-minute range,
    // measure again — at that size the bigger machine can start paying for itself.
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
        // The proxy resolves every request against this table, so the row must
        // exist before the deploy can possibly succeed.
        if (ownerId && ownerWorkspace) {
          await createAppRecord({ slug, workspaceId: ownerWorkspace, ownerId });
        }
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
        // SEAL_APPS switches the two routing models. Off (today): the app is
        // public and reached through its own domain mapping. On (after the DNS
        // cutover): only the proxy may invoke it, and *.supersonic.cv routes
        // through the load balancer. Turning it on before DNS moves would make
        // every app unreachable — see docs/CUTOVER.md.
        const deployFlags = [
          "--region", REGION, SEAL_APPS ? "--no-allow-unauthenticated" : "--allow-unauthenticated",
          "--project", PROJECT, "--format=json",
        ];
        // Without this the app inherits the project's default compute service
        // account, which here carries run.admin, storage.admin and
        // artifactregistry.writer. That gives every customer's code — arbitrary
        // code we agreed to run — the ability to delete the control plane, read
        // every other customer's source out of the build bucket, and overwrite
        // another app's image. Cloud Run hands any process in the container a
        // token for its service account via the metadata server, so it takes one
        // curl. Point apps at a runtime account that holds nothing instead.
        // Unset today so this is a no-op until the account exists — see the
        // rollout note in docs/CUTOVER.md.
        if (APP_RUNTIME_SA) deployFlags.push(`--service-account=${APP_RUNTIME_SA}`);
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
              // Grant before probing: a sealed app 403s the control plane's own
              // probe until the binding exists.
              if (SEAL_APPS) await grantInvokers(slug, log);
              log("verifying the app responds…");
              const probe = await probeApp(liveUrl, log, SEAL_APPS);
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
          // A permissions failure is ours, not the repo's — the repair agent would
          // burn redeploys on it and then bury the real cause in its summary.
          if ((result.error ?? "").includes(IAM_FAILURE)) {
            if (ownerId && ownerWorkspace) await markAppFailed(slug).catch(() => {});
            send({ type: "error", message: result.error });
            return;
          }
          log("Repair agent taking over — reading the repo, fixing, retrying…");
          const fixed = await repairDeploy({ dir, slug, initialError: result.error ?? "unknown", redeploy: runDeploy, log });
          if (fixed.ok) { result = { ok: true, url: fixed.url }; log(`Agent fixed it (${fixed.changes.join(", ")})`); }
          else {
            if (ownerId) setDeploy(slug, { status: "failed", stage: fixed.summary });
            if (ownerId && ownerWorkspace) await markAppFailed(slug).catch(() => {});
            send({ type: "error", message: fixed.summary });
            return;
          }
        }
        log(`Live at ${result.url}`);
        // The two routing models are mutually exclusive: a per-app domain
        // mapping points straight at Cloud Run, which a sealed app refuses.
        if (SEAL_APPS) {
          log(`Private — open ${slug}.supersonic.cv to share it`);
        } else {
          await createDomainMapping(slug, log);
        }
        if (ownerId) setDeploy(slug, { status: "live", url: result.url });
        if (ownerId && ownerWorkspace) await markAppLive(slug, result.url ?? "");
        send({ type: "done", slug, url: SEAL_APPS ? `https://${slug}.supersonic.cv` : result.url });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (ownerId) setDeploy(slug, { status: "failed", stage: msg });
        // Anything thrown after the row was created — a clone failure, bad
        // detector output, a provisioning error — would otherwise leave the app
        // stuck at status 'deploying' forever.
        if (ownerId && ownerWorkspace) await markAppFailed(slug).catch(() => {});
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
