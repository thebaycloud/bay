// Everything below moved here from app/api/deploy/route.ts unchanged; see runDeploy.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, existsSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairDeploy } from "@/lib/agent";
import { opencodeRepair, planDeploy, PartialPlan, type DeployPlan } from "@/lib/opencode-deploy";
import { checkPlanDeps, assertRuntimeSupported, RUNTIME_UNSUPPORTED } from "@/lib/plan-deps";
import { readRepoFacts, refusalReason } from "@/lib/repo-facts";
import { planKey, getCachedPlan, putCachedPlan } from "@/lib/plan-cache";
import { snapshotSources, repairPatch } from "@/lib/repair-diff";
import { putAppSecrets, setSecretsFlag, grantBuildAccess, type SecretRef } from "@/lib/app-secrets";
import { cloudRunName } from "@/lib/slug";
import { readAppConfig, planFromConfig, ConfigError, CONFIG_FILENAME, primaryService, extraServices, servicePath, usesDatabase, type ServiceConfig, type AppConfig, type HealthConfig } from "@/lib/app-config";
import { inferAppConfig, type DetectedStack } from "@/lib/infer-services";
import { mergeDatabaseEnv, configEnv } from "@/lib/env-merge";
import { pgConfig } from "@/lib/pg-config";
import { dbNameForSlug } from "@/lib/db";
import { createAppRecord, markAppLive, markAppFailed } from "@/lib/apps";
import { requestThumbnail } from "@/lib/thumbnail";
import { setDeploy } from "@/lib/deploys";
import { notifyDeployFinished } from "@/lib/deploy-notify";
import { releaseId, releasePrefix, pointerPath, ASSETS_BUCKET } from "@/lib/static-release";
import { listObjectNames, readObjectText, writeObject, describeServiceRest } from "@/lib/gcp-rest";
import { take as takeClone } from "@/lib/clone-cache";
import { staticBuildConfig } from "@/lib/static-build";
import { verifyRelease } from "@/lib/verify-release";
import { StageRecorder } from "@/lib/stages";
import { stripQualityGates } from "@/lib/build-gates";
import { type Limits } from "@/lib/entitlements";
import { cachedBuildConfig, selectedBuilder, buildLogLine, CACHE_MISS_NOISE, runnerPrepareConfig, appBuildTag, cloudBuildIdFrom } from "@/lib/build-config";
import { deployArgs, databaseEnv, DB_HOST, DB_PORT, DEFAULT_SCALE, type Scale } from "@/lib/lanes";
import { verifyApp } from "@/lib/verify-app";
import { ensureAppRole, DB_PASSWORD_SECRET } from "@/lib/pg-role";
import { classify } from "@/lib/deploy-errors";
import { releaseJobArgs, releaseExecuteArgs, releaseLogsArgs, releaseFromPlan } from "@/lib/release-job";
// frameworkBuildEnv is deliberately not wired here yet: build-time variables
// have to reach the Cloud Build config, not the revision, and that is Phase 7d.
import { deploymentEnv } from "@/lib/framework-env";
import { resolveFrom, type DeploymentFacts } from "@/lib/resolve";
import { buildEnvelope, assertReached } from "@/lib/envelope";

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
// The identity the prepare step actually runs as, and therefore what must be able
// to read the app's secrets.
//
// NOT `<project-number>@cloudbuild.gserviceaccount.com`, which is the obvious
// guess and is wrong here: builds submitted without an explicit service account
// run as the project's DEFAULT COMPUTE account. Guessing cost a deploy that
// failed with "Permission 'secretmanager.versions.access' denied" on a secret
// that existed and was granted — to somebody else.
const BUILD_SA = process.env.CLOUD_BUILD_SERVICE_ACCOUNT || "540236122367-compute@developer.gserviceaccount.com";
/** Runtime identity for the apps we host. Empty = inherit the project default. */
const APP_RUNTIME_SA = process.env.APP_RUNTIME_SERVICE_ACCOUNT ?? "";
/** The one Cloud Run service that fronts every static app. */
const STATIC_SERVICE = process.env.STATIC_SERVICE ?? "supersonic-static";
const AGENT = join(process.cwd(), "..", "..", "services", "deploy-agent");

/**
 * The prebuilt-runner lane. Instead of building a container image per app
 * (install → docker build → push → deploy, the slow path), the app's code is
 * uploaded to GCS and a Cloud Run revision is pointed at a shared base image that
 * ALREADY carries the popular packages (services/runner). The runner fetches the
 * code and runs it — no per-app build. Language is a two-way Node/Python fork,
 * not a framework matrix; the weird 10% still falls to the opencode repair loop.
 *
 * Behind RUNNER=1 so it ships dark and the current build path is untouched until
 * the runner base images exist in Artifact Registry (see services/runner/build.sh).
 */
const RUNNER_ENABLED = process.env.RUNNER === "1";
// Agent planner: opencode reads the repo and decides how to install/build/run,
// replacing the hardcoded stack detector's recipes. Dark until proven; the
// deterministic detector stays as the fallback so a deploy never dies because
// planning hiccuped. Needs RUNNER=1 to actually route server apps to the runner.
const PLANNER_ENABLED = process.env.PLANNER === "1";
const RUNNER_NODE_IMAGE = process.env.RUNNER_NODE_IMAGE
  ?? `${REGION}-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy/runner-node:latest`;
const RUNNER_PYTHON_IMAGE = process.env.RUNNER_PYTHON_IMAGE
  ?? `${REGION}-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy/runner-python:latest`;
const ENV = {
  ...process.env,
  PATH: `/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH ?? ""}`,
  CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
} as NodeJS.ProcessEnv;

function forEachLine(buf: Buffer, cb: (l: string) => void) {
  buf.toString().split(/\r?\n/).forEach((l) => { if (l.trim()) cb(l.trim()); });
}
function run(cmd: string, args: string[], onLine: (l: string) => void, stdin?: string) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { env: ENV });
    p.stdout.on("data", (d: Buffer) => forEachLine(d, onLine));
    p.stderr.on("data", (d: Buffer) => forEachLine(d, onLine));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
    // Writing the release pointer is a few bytes; piping them beats a temp file.
    if (stdin !== undefined) { p.stdin.on("error", reject); p.stdin.end(stdin); }
  });
}
/**
 * Run a command, and if it fails, say what it said.
 *
 * `run()` takes a line callback, and two call sites passed `() => {}` — which
 * discards the process's entire output, so a failure surfaced as nothing but
 * `gcloud exited 1`. On the static lane that was the whole diagnosis available:
 * it builds nothing, so there is no Cloud Build log to fall back on, and a plain
 * HTML site failed to deploy with no cause recorded anywhere in the system. The
 * repair agent then spent 428k tokens guessing, and settled on deleting a favicon
 * tag. Output that is not shown live still has to be kept for the error.
 */
async function runOrExplain(cmd: string, args: string[], onLine?: (l: string) => void): Promise<void> {
  const tail: string[] = [];
  try {
    await run(cmd, args, (l) => {
      tail.push(l);
      if (tail.length > 40) tail.shift();
      onLine?.(l);
    });
  } catch (e) {
    const said = tail.filter((l) => l.trim()).join("\n");
    throw new Error(said ? `${e instanceof Error ? e.message : String(e)}\n${said}` : String(e));
  }
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

/**
 * The detector, pointed at one directory.
 *
 * Identical to the detect stage's own invocation — deliberately the same
 * subprocess and the same `--api` envelope, so a service inferred from a
 * subdirectory is read by exactly the code that reads a single-app repo, and the
 * two cannot drift into disagreeing about what a Vite project is.
 */
async function detectStackIn(absoluteDir: string): Promise<DetectedStack> {
  const raw = await capture("npm", ["--prefix", AGENT, "run", "detect", "--silent", "--", absoluteDir, "--api"]);
  return JSON.parse(raw.slice(raw.indexOf("{"))).stack as DetectedStack;
}
/**
 * The container's ACTUAL startup crash, from Cloud Run's logs.
 *
 * A "didn't start on $PORT" is a symptom — the cause is whatever the process
 * printed before it died (a missing env, an uncaught throw, `@prisma/client did
 * not initialize`). Without this the repair agent only sees our generic guess and
 * invents a fix (famously: "it must be the PORT"), then redeploys 3× chasing it.
 * Handing it the real error is the difference between one honest fix and a loop.
 */
async function fetchContainerError(slug: string): Promise<string | null> {
  try {
    const out = await capture("gcloud", [
      "logging", "read",
      `resource.type=cloud_run_revision AND resource.labels.service_name=${slug} AND severity>=ERROR`,
      "--project", PROJECT, "--limit", "25", "--freshness", "10m",
      "--format=value(textPayload)", "--order=asc",
    ]);
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean)
      .filter((l) => !/STARTUP (TCP|HTTP) probe|Default STARTUP|Connection failed with status/i.test(l));
    const signal = lines.filter((l) => /error|exception|throw|cannot|not initialize|not found|refused|denied|undefined|EADDR|traceback|fatal|missing|required/i.test(l));
    const pick = (signal.length ? signal : lines).slice(0, 12);
    return pick.length ? pick.join("\n") : null;
  } catch { return null; }
}

/** The control plane's own service account, read from the metadata server. */
async function controlPlaneSA(): Promise<string | null> {
  try {
    const r = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email", {
      headers: { "Metadata-Flavor": "Google" },
    });
    return r.ok ? (await r.text()).trim() : null;
  } catch { return null; }
}

/**
 * Mint a per-object V4 signed GET URL for a code bundle.
 *
 * This is what lets the runner fetch its bundle WITHOUT the shared, locked-down
 * runtime SA holding any bucket read — the URL is a capability scoped to one
 * object, so one app can never read another's source. Signing is stateless
 * (`sign-url` only calls IAM signBlob, never GCS), so the object need not exist
 * yet; it will by the time the container fetches it. Requires the control-plane
 * SA to hold Token Creator on itself (to signBlob) and read on the bucket.
 *
 * Best-effort: on any failure the caller falls back to the direct-read env, which
 * fails loudly with the "not allowed to read the code bundle" message rather than
 * silently. 7 days is the V4 max; a redeploy refreshes it.
 */
async function signedBundleUrl(bucket: string, object: string, log: (l: string) => void): Promise<string | null> {
  try {
    const sa = await controlPlaneSA();
    const args = ["storage", "sign-url", `gs://${bucket}/${object}`, "--http-verb=GET", "--duration=7d", "--project", PROJECT, "--format=json"];
    if (sa) args.push(`--impersonate-service-account=${sa}`);
    const out = await capture("gcloud", args);
    const start = out.indexOf("[");
    const arr = start >= 0 ? JSON.parse(out.slice(start)) : null;
    const o = Array.isArray(arr) ? arr[0] : arr;
    const url = o?.signed_url || o?.signedUrl || o?.url;
    return typeof url === "string" && url ? url : null;
  } catch (e) {
    log(`! bundle-URL signing failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
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

// Basic plan doesn't get the auto-fix agent — it gets a paste-ready prompt to
// hand its own coding agent. This turns a raw deploy error into that prompt.
function fixPrompt(slug: string, error: string): string {
  return [
    "My deploy to Supersonic failed. Fix the code so it deploys cleanly, then",
    "run `supersonic deploy` again from the project root.",
    "",
    "Here is the exact error from the build/deploy:",
    "",
    error.trim(),
  ].join("\n");
}

// onRaw sees EVERY line; onLine only the ones worth showing a user. The
// distinction matters for `--source` deploys: gcloud prints the id of the build
// it just started on an ordinary informational line, which the onLine filter
// drops — and that id is the only thing that later identifies whose build failed.
function gcloudDeploy(args: string[], onLine: (l: string) => void, onRaw?: (l: string) => void) {
  return new Promise<string>((resolve, reject) => {
    const p = spawn("gcloud", args, { env: ENV });
    let out = "";
    const errTail: string[] = [];
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.stderr.on("data", (d: Buffer) => {
      d.toString().split(/\r?\n/).forEach((raw) => {
        const l = raw.trim();
        if (!l) return;
        onRaw?.(l);
        errTail.push(l);
        if (errTail.length > 60) errTail.shift();
        if (/fail|error|listen on the port|Revision|Cloud Run error/i.test(l)) onLine(l);
      });
    });
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(diagnose(errTail)))));
  });
}

/** Create a per-app database on the shared Cloud SQL instance and return a socket DATABASE_URL. */
function provisionPostgres(slug: string, log: (l: string) => void): Promise<{ databaseUrl: string; connectionName: string; user: string; password: string; dbName: string; isolated: boolean }> {
  let cfg;
  try { cfg = pgConfig(); } catch (e) { return Promise.reject(e); }
  // Same helper the delete path uses, so an app's database can always be found
  // again by name — a second, drifting copy of this rule is how they got orphaned.
  const dbName = dbNameForSlug(slug);
  return capture("gcloud", ["sql", "databases", "create", dbName, "--instance=supersonic-shared-pg", "--project", PROJECT])
    .catch((e: Error) => { if (/already exists/i.test(e.message)) return ""; throw e; })
    .then(async () => {
      log(`Provisioned Postgres database ${dbName}`);
      // Its own login, and CONNECT taken away from PUBLIC. Until this existed
      // every app received the cloudsqlsuperuser credential, and reaching another
      // app's database took a one-line change to a connection string.
      const role = await ensureAppRole(slug, dbName, { user: cfg.user, password: cfg.password }, log);
      // An ordinary host and port, because the app reaches Postgres through a
      // Cloud SQL Auth Proxy running beside it — see dbContainerArgs.
      //
      // It used to be a Unix socket, expressed as `@localhost/db?host=/cloudsql/…`,
      // and that shape only works for clients that understand the `host=`
      // parameter. Any app that assembles its own connection URL from parts
      // cannot express a socket at all: `PostgresDsn.build(host="/cloudsql/…")`
      // is REJECTED outright (verified), so a socket left every such app unable
      // to reach a database the platform had already created for it.
      const databaseUrl = `postgresql://${role.user}:${role.password}@${DB_HOST}:${DB_PORT}/${dbName}`;
      return { databaseUrl, connectionName: cfg.connectionName, user: role.user, password: role.password, dbName, isolated: role.isolated };
    });
}

/**
 * Where an app finds its database: a normal host and port, on localhost.
 *
 * Provided by a Cloud SQL Auth Proxy container running alongside the app. The
 * alternative — Cloud Run's built-in Unix socket at /cloudsql/<instance> — works
 * only for clients that speak the `host=` connection parameter, and is
 * impossible for the large class of apps that build a connection URL out of
 * separate host/user/password/database settings. A filesystem path is not a
 * valid URL host and pydantic, among others, rejects it outright.
 *
 * One address means every convention below works with no special cases.
 *
 * DB_HOST/DB_PORT, `databaseEnv` and `dbContainerArgs` now live in lib/lanes.ts,
 * beside the argv builder that is their only consumer — and beside the
 * protected-name set that is derived from `databaseEnv` rather than typed out
 * again.
 */

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

  // Apps share one runtime identity, so bucket access has to be granted per bucket
  // rather than project-wide — a project-level grant would hand every app the keys
  // to every other app's storage, which is the thing the runtime account exists to
  // stop. Best-effort: an app whose binding fails still deploys, it just cannot
  // write objects, and that is visible in its own logs rather than as a dead deploy.
  if (APP_RUNTIME_SA) {
    try {
      await capture("gcloud", [
        "storage", "buckets", "add-iam-policy-binding", `gs://${bucket}`,
        "--member", `serviceAccount:${APP_RUNTIME_SA}`,
        "--role", "roles/storage.objectAdmin",
        "--project", PROJECT,
      ]);
    } catch (e) {
      log(`! storage permission not granted: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return bucket;
}

const PROXY_SA = process.env.PROXY_SERVICE_ACCOUNT
  ?? "supersonic-proxy@supersonic-deploy-prod.iam.gserviceaccount.com";

/** Marks a failure the repair agent has no way to fix — permissions, not code. */
const IAM_FAILURE = "IAM binding failed";

/**
 * Marks a deploy we refused rather than guessed at.
 *
 * Also nothing the repair agent can fix: there is no bug in the repository, only
 * a question the platform could not answer. Handing it over would produce
 * exactly what it produced on 1 Aug — an agent editing correct code to fit a
 * lane that was chosen wrongly in the first place.
 */
const AMBIGUOUS_STACK = "Cannot tell what this app is";

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
  // Says what the visitor will actually experience, not what the platform did.
  // "Sealed" described our end of it and left people clicking their own brand-new
  // URL, hitting a sign-in wall, and concluding the deploy was broken — the one
  // remaining way a successful deploy still looked like a failure.
  log("Private by default — anyone opening this link has to sign in. Change that in the dashboard.");
}

/** Mint an ID token for a Cloud Run URL so we can call a sealed service. */
async function idTokenFor(audience: string): Promise<string> {
  return (await capture("gcloud", ["auth", "print-identity-token", `--audiences=${audience}`])).trim();
}

// After a deploy passes Cloud Run's health check, actually fetch the app: a
// server can "listen" yet still reject the real request (e.g. Vite preview host
// allowlisting), which we must catch and repair. The app is sealed, so this
// request carries an ID token exactly as the proxy's would.
//
// The judgement about what counts as working lives in lib/verify-app.ts; this
// is only the part that needs the deployer's credentials.
async function probeApp(
  url: string,
  log: (l: string) => void,
  sealed: boolean,
  health?: { health: HealthConfig; strict: boolean; spaFallback?: boolean },
): Promise<{ ok: boolean; reason?: string }> {
  // A sealed app cannot be reached without a token, so mint it outside the check
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
  return verifyApp({
    url,
    health: health?.health ?? { path: "/", expect: 200 },
    strict: health?.strict ?? false,
    spaFallback: health?.spaFallback,
    headers: auth,
    log: (l) => log(l),
  });
}

/**
 * Tracks which Cloud Build belongs to THIS deploy, so its failure can be read
 * back without asking "what was the last build in the project?".
 *
 * That question used to be the implementation (`builds list --limit 1`, no
 * filter) and it is wrong the moment two deploys overlap — which is the normal
 * state of an agent platform. The consequence is not a cosmetic mix-up: this log
 * is the evidence the repair agent debugs from, so a stranger's build failure
 * sends it editing this customer's code to fix a bug that was never in it, and
 * the customer reads someone else's build output as their own.
 *
 * Primary source is the build's own id, sniffed from the log-URL line the
 * command prints. Fallback is this app's tagged builds. If neither is available
 * the answer is nothing — an unattributed log is worse than no log, because the
 * caller falls back to the real exception instead of being confidently misled.
 */
function buildWatcher(slug: string) {
  let id: string | null = null;
  return {
    /** Feed every raw line of a build command's output through this. */
    note(line: string) {
      const found = cloudBuildIdFrom(line);
      if (found) id = found;
    },
    /** Before starting a build: a retry must not read the previous attempt's log. */
    reset() { id = null; },
    error() { return fetchBuildError(id, slug); },
  };
}

/**
 * Delete symlinks whose target is not there.
 *
 * `gcloud builds submit` CRASHES on a dangling symlink — not "fails", crashes:
 * `gcloud crashed (FileNotFoundError): [Errno 2] No such file or directory` while
 * it packs the source, with no indication which file or that a symlink is
 * involved. A repair agent handed that error has nothing to work with and cannot
 * fix it anyway; one spent 626k tokens editing package.json and tsconfig before
 * giving up.
 *
 * And the dangling links are usually OURS. The CLI excludes `.venv`,
 * `node_modules` and friends from the upload, so any symlink pointing INTO one of
 * them arrives with its target removed — links that resolve perfectly on the
 * developer's machine. Found on fastapi/full-stack-fastapi-template, whose
 * `.agents/skills/*` point into `.venv`.
 *
 * Removed rather than followed: the target was deliberately excluded, so
 * dereferencing would drag a whole virtualenv into the build.
 */
function pruneBrokenSymlinks(root: string, log: (l: string) => void): void {
  const removed: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 12) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isSymbolicLink()) {
        if (!existsSync(full)) {                 // existsSync follows the link
          try { unlinkSync(full); removed.push(full.slice(root.length + 1)); } catch { /* nothing to do */ }
        }
        continue;                                 // never descend through a link
      }
      if (e.isDirectory() && e.name !== ".git") walk(full, depth + 1);
    }
  };
  walk(root, 0);
  if (removed.length) {
    log(`Ignoring ${removed.length} broken symlink${removed.length > 1 ? "s" : ""} (${removed.slice(0, 3).join(", ")}${removed.length > 3 ? "…" : ""}) — their targets are not part of a deploy`);
  }
}

/**
 * Make sure the program the plan says to run will be there when it runs.
 *
 * The planner writes the production run command, and it writes good ones — but
 * "how is Flask served in production" has an answer (`gunicorn`) that is correct
 * everywhere except in a project that never installed gunicorn. Nothing about
 * that repo is wrong, so the model cannot see it; install and build both succeed,
 * so the build cannot see it. It surfaces only at container start, as exit 127,
 * which reaches the repair agent disguised as "the app didn't listen on $PORT" —
 * and that disguise has already cost one deploy three redeploys chasing a port
 * bug that did not exist.
 *
 * The fix is the one a person would make: add the missing server to
 * requirements.txt. In OUR copy of the repo, never the user's — same rule as
 * stripQualityGates. Everything the check is not certain about is logged instead,
 * so a 127 that still happens is one line away from being understood.
 */
function ensureRunDeps(dir: string, plan: DeployPlan, log: (l: string) => void) {
  const reqPath = join(dir, "requirements.txt");
  const pkgPath = join(dir, "package.json");
  const readOr = (p: string) => { try { return existsSync(p) ? readFileSync(p, "utf8") : null; } catch { return null; } };
  const requirements = readOr(reqPath);
  let packageJson: unknown = null;
  try { const raw = readOr(pkgPath); if (raw) packageJson = JSON.parse(raw); } catch { /* unparseable — treated as absent */ }

  const { install, unknown } = checkPlanDeps(plan, { language: plan.language, requirements, packageJson });

  if (install.length && requirements !== null) {
    const suffix = requirements.endsWith("\n") || requirements === "" ? "" : "\n";
    writeFileSync(reqPath, `${requirements}${suffix}${install.join("\n")}\n`);
    log(`The run command needs ${install.join(", ")}, which this project does not install — adding it (our copy only)`);
  }
  // Not an error: the check is narrow on purpose, and most of what lands here is a
  // binary that really does exist (a transitive dep's bin, a workspace tool). It is
  // here so that when one of them *is* the reason for a 127, the log already says so.
  if (unknown.length) log(`Note: could not confirm ${unknown.join(", ")} will be installed — if the app exits 127, this is why`);
}

// A failed `gcloud run deploy --source` only says "Build failed; check logs".
// Pull the actual Cloud Build output so the repair agent fixes the real error.
async function fetchBuildError(buildId: string | null, slug: string): Promise<string> {
  try {
    let id = buildId;
    if (!id) {
      // No id was printed (or parsed). Fall back to this app's OWN most recent
      // build — every config we generate carries the slug as a Cloud Build tag —
      // and never to an unfiltered `--limit 1`, which returns whichever tenant
      // happened to build last.
      const list = await capture("gcloud", ["builds", "list", "--region", REGION, "--project", PROJECT,
        "--filter", `tags=${appBuildTag(slug)}`, "--limit", "1", "--format=value(id)"]);
      id = list.trim().split("\n")[0] || null;
    }
    if (!id) return "";
    const raw = await capture("gcloud", ["beta", "builds", "log", id, "--region", REGION, "--project", PROJECT]);
    const lines = raw.split("\n").map((l) => l.replace(/^Step #\d+ - "[^"]*":\s?/, "").replace(/\r/g, "").trimEnd()).filter((l) => l.trim() && !CACHE_MISS_NOISE.test(l));
    // Keep the lines that actually explain a failure — not only ones containing the
    // word "error". A build tool's real cause is often phrased as advice ("not
    // compatible with export", "Possible solutions", "Configure X"); dropping those
    // leaves only a generic "build step failed", which sends the repair agent down
    // the wrong path (e.g. blaming the Node version). Fall back to the tail, where
    // the failure always lands.
    const keep = /error|fail|not found|cannot|npm ERR|\berror TS\d|Error:|exit code|Module not found|ENOENT|EACCES|SyntaxError|TypeError|denied|not compatible|unsupported|incompatible|invalid|Possible solutions|Configure |Read more|^\s*-\s|warning|deprecated/i;
    // The cold-cache line is dropped upstream, when `lines` is built: buildx
    // prints it as an ERROR and then carries on to exit 0, and it matches `keep`
    // twice over, so left in it would be handed to the repair agent as "the
    // actual build output" and the agent would go fix the customer's code over a
    // warning that only means "this is the first build".
    const kept = lines.filter((l) => keep.test(l));
    return (kept.length ? kept : lines).slice(-40).join("\n");
  } catch {
    return "";
  }
}

// SPAs (Vite/CRA) are static sites, not servers. Build them and serve the
// output on $PORT instead of trying to run a dev/preview server.
/**
 * Node base image for generated Dockerfiles.
 *
 * Pointing this at our own regional Artifact Registry removes a Docker Hub pull
 * — and its rate limit — from every build, and the mirrored image carries a
 * pre-populated package cache for the stack. Unset today, so builds keep using
 * Docker Hub until the mirror exists: a base that cannot be pulled must never be
 * able to take deploys down.
 */
const NODE_BASE = process.env.NODE_BASE_IMAGE || "node:22-slim";
/** npm registry for generated builds. Empty = the public default. */
const NPM_REGISTRY = process.env.NPM_REGISTRY || "";
const npmRegistryLine = NPM_REGISTRY ? `RUN npm config set registry ${NPM_REGISTRY}` : null;
/** Audit and funding run on every build and buy us nothing. */
const NPM_FLAGS = "--prefer-offline --no-audit --no-fund";

function spaDockerfile(outdir: string): string {
  return [
    `FROM ${NODE_BASE} AS build`,
    "WORKDIR /app",
    npmRegistryLine,
    "COPY package*.json ./",
    `RUN npm install ${NPM_FLAGS}`,
    "COPY . .",
    "RUN npm run build",
    "",
    `FROM ${NODE_BASE}`,
    "WORKDIR /app",
    npmRegistryLine,
    `RUN npm install -g serve ${NPM_FLAGS}`,
    `COPY --from=build /app/${outdir} ./public`,
    "ENV PORT=8080",
    "EXPOSE 8080",
    'CMD ["sh","-c","serve -s public -l ${PORT}"]',
    "",
  ].filter((l) => l !== null).join("\n");
}

// Next.js (and other build-then-serve node frameworks) MUST run their build
// before `next start`, or the container crashloops with "no production build in
// .next". Buildpacks don't reliably run the build (esp. with mixed lockfiles),
// so we inject an explicit build -> start Dockerfile. Forcing `npm install` also
// resolves the classic package-lock.json + yarn.lock ambiguity.
function nextDockerfile(): string {
  const base = process.env.NEXT_BASE_IMAGE || NODE_BASE;
  return [
    `FROM ${base} AS build`,
    "WORKDIR /app",
    "ENV NEXT_TELEMETRY_DISABLED=1",
    npmRegistryLine,
    "COPY package*.json ./",
    `RUN npm install ${NPM_FLAGS} --legacy-peer-deps`,
    "COPY . .",
    "RUN npm run build",
    "",
    `FROM ${base}`,
    "WORKDIR /app",
    "ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080",
    "COPY --from=build /app ./",
    "EXPOSE 8080",
    'CMD ["npm","run","start"]',
    "",
  ].filter((l) => l !== null).join("\n");
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

/**
 * The old listing path, kept verbatim as the fallback for when REST cannot
 * answer. `gcloud storage ls -r` prints absolute gs:// URLs, one per line.
 */
async function listViaGcloud(destination: string): Promise<string[]> {
  const listing = await capture("gcloud", ["storage", "ls", "-r", `${destination}**`, "--project", PROJECT]);
  return listing
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(destination) && !l.endsWith("/"))
    .map((l) => l.slice(destination.length));
}

/**
 * Name the live release. This is the single write that makes a deploy visible,
 * so it stays strictly last and its bytes stay exactly what they were: the
 * release id, raw, no trailing newline.
 *
 * REST does it in one request; a failure falls through to the gcloud command
 * that has always done it. A simple upload is atomic, so a failed REST attempt
 * leaves the previous pointer untouched and the retry writes the same bytes.
 */
async function writePointer(slug: string, release: string): Promise<void> {
  if (await writeObject(ASSETS_BUCKET, pointerPath(slug), release)) return;
  await run("gcloud", ["storage", "cp", "-", `gs://${ASSETS_BUCKET}/${pointerPath(slug)}`, "--project", PROJECT], () => {}, release);
}

/**
 * Read back what a release actually landed in storage and decide whether it may
 * become the live one. Throws with the reason if it may not.
 *
 * REST first (one HTTP request), gcloud only if that could not answer. The two
 * produce the same list — `storage ls -r 'gs://b/p**'` and objects.list over the
 * same prefix were diffed and are identical.
 *
 * Both publishing lanes call this. The prebuilt lane always did; the static lane
 * did not, and that is why a Cloud Build step that reported SUCCESS while
 * uploading nothing was able to move `jdmis`'s pointer to a release that does
 * not exist. A build's exit code says the step ran, not that it published.
 */
async function assertReleaseUploaded(prefix: string, destination: string, log: (l: string) => void): Promise<void> {
  const present = (await listObjectNames(ASSETS_BUCKET, prefix)) ?? (await listViaGcloud(destination));

  let indexHtml: string | null = null;
  if (present.includes("index.html")) {
    indexHtml = (await readObjectText(ASSETS_BUCKET, `${prefix}index.html`))
      ?? (await capture("gcloud", ["storage", "cat", `${destination}index.html`, "--project", PROJECT]));
  }

  const verdict = verifyRelease(present, indexHtml);
  if (!verdict.ok) {
    // The release stays in storage but is never named, so the live site is
    // exactly as it was a moment ago.
    throw new Error(`${verdict.reason} — your site was left on the previous release`);
  }
  log(`${present.length} files check out`);
}

/**
 * Publish a release the CLI already built.
 *
 * Nothing is detected, installed or built here — that work happened on the user's
 * machine, where the project already lives and its build takes seconds. All that is
 * left is: unpack, upload, check, flip.
 *
 * The check is the reason a bad local build cannot take a site down. Until the pointer
 * moves at the end, the previous release is serving and completely untouched.
 */
async function publishPrebuilt(opts: {
  dir: string;
  archive: Buffer;
  slug: string;
  hash: string;
  log: (l: string) => void;
  send: (o: unknown) => void;
  stages: StageRecorder;
}): Promise<void> {
  const { dir, archive, slug, hash, log, send, stages } = opts;
  const release = releaseId();
  const prefix = releasePrefix(slug, release);
  const destination = `gs://${ASSETS_BUCKET}/${prefix}`;

  await stages.around("unpack", async () => {
    log("Unpacking your build…");
    const tgz = `${dir}.tgz`;
    writeFileSync(tgz, archive);
    await run("tar", ["-xzf", tgz, "-C", dir], () => {});
    pruneBrokenSymlinks(dir, log);
  });

  await stages.around("upload", async () => {
    log("Uploading…");
    await run("gcloud", ["storage", "rsync", "-r", dir, destination, "--project", PROJECT], () => {});
  });

  await stages.around("verify", async () => {
    log("Checking the build…");
    await assertReleaseUploaded(prefix, destination, log);
  });

  // Only now, with a release known to be coherent, does it become the live one.
  await writePointer(slug, release);
  log(`Published release ${release}`);
  send({ type: "detected", stack: { framework: "prebuilt", language: "static" }, plan: [] });
  if (hash) log("Recorded this build, so an unchanged redeploy will skip the upload");
}

/** Cached because it is the same value for every static deploy. */
let staticUrlCache: string | null = null;
async function staticServiceUrl(): Promise<string | null> {
  if (staticUrlCache) return staticUrlCache;
  // The Knative v1 resource REST returns is the same one gcloud prints, so
  // status.url is status.url either way.
  const svc = await describeServiceRest(STATIC_SERVICE);
  const restUrl = typeof svc?.status?.url === "string" ? svc.status.url.trim() : "";
  if (restUrl.startsWith("https://")) { staticUrlCache = restUrl; return restUrl; }
  try {
    const out = await capture("gcloud", [
      "run", "services", "describe", STATIC_SERVICE,
      "--region", REGION, "--project", PROJECT, "--format=value(status.url)",
    ]);
    const url = out.trim();
    if (url.startsWith("https://")) { staticUrlCache = url; return url; }
  } catch { /* not deployed yet */ }
  return null;
}

// Give the app a <slug>.supersonic.cv address (the wildcard *.supersonic.cv
// CNAME + this per-app mapping is what routes it). SSL provisions async.
// `service` is the Cloud Run service behind the name: the app's own for the
// container lanes, the one shared static server for the static lane.
async function createDomainMapping(slug: string, log: (l: string) => void, service: string = slug): Promise<void> {
  try {
    await capture("gcloud", ["beta", "run", "domain-mappings", "create", "--service", service, "--domain", `${slug}.supersonic.cv`, "--region", REGION, "--project", PROJECT]);
    log(`Mapped ${slug}.supersonic.cv (SSL provisioning, live in ~15 min)`);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/already exists/i.test(m)) { log(`${slug}.supersonic.cv already mapped`); return; }
    log(`! custom domain skipped: ${m.replace(/\s+/g, " ").slice(0, 100)}`);
  }
}

/**
 * The deploy itself: source in, a running app out.
 *
 * This is deliberately NOT in the route file. A Next.js route may only export
 * request handlers, so as long as the pipeline lived inside `POST` the only way
 * to run a deploy was to be an HTTP request that stays open for it — which is
 * how a build came to depend on a socket surviving: the request handler is also
 * the worker, so anything that ends the request (an instance recycled, a
 * scale-down SIGTERM, the 600s maxDuration cap) ends a deploy that was working.
 * Out here it is an ordinary async function over an event sink, callable from a
 * request today and from a job that outlives one next.
 *
 * `emit` receives the same events the SSE stream carries. It must never throw:
 * a client that hung up is not a reason to stop building.
 */
export interface DeployInput {
  ownerId: string;
  ownerWorkspace: string | null;
  slug: string;
  friendlyName: string;
  /** The git URL to clone, or "" when the source arrived as an upload. */
  repoUrl: string;
  isUpload: boolean;
  isPrebuilt: boolean;
  prebuiltHash: string;
  secrets: Record<string, string>;
  archive: Buffer | null;
  cloneToken: unknown;
  /** The production run command handed over by the deploying agent, if any. */
  runCmd: string;
  limits: Limits;
}

export async function runDeploy(input: DeployInput, emit: (e: unknown) => void): Promise<void> {
  const {
    ownerId, ownerWorkspace, slug, friendlyName, isUpload, isPrebuilt,
    prebuiltHash, secrets, archive, cloneToken, limits,
  } = input;
  // Rebound because the pipeline reassigns them as it learns more: the run
  // command can come from the plan, and `url` becomes the live URL.
  let runCmd = input.runCmd;
  /** The one-shot pre-traffic command, held out of `start`. See lib/release-job.ts. */
  let releaseCmd = "";
  const url = input.repoUrl;
  const send = emit;
  let stages = new StageRecorder(slug, "generic");
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
    // /api/detect already cloned this repo moments ago. Reuse that clone when
    // it is still around. A miss — a different control-plane instance, an
    // expired entry — just means cloning again, never a failed deploy.
    const reused = isUpload ? null : takeClone(cloneToken);
    const dir = reused ?? mkdtempSync(join(tmpdir(), "ss-deploy-"));

    if (isPrebuilt && archive) {
      stages = new StageRecorder(slug, "static");
      await publishPrebuilt({ dir, archive, slug, hash: prebuiltHash, log, send, stages });
      setDeploy(slug, { status: "live", url: `https://${slug}.supersonic.cv` });
      if (ownerId && ownerWorkspace) {
        const staticUrl = (await staticServiceUrl()) ?? "";
        await markAppLive(slug, staticUrl, prebuiltHash || null);
        void requestThumbnail(slug, staticUrl);
      }
      send({ type: "done", slug, url: `https://${slug}.supersonic.cv` });
      return;
    }

    if (isUpload && archive) {
      await stages.around("unpack", async () => {
        log("Unpacking your project…");
        const tgz = `${dir}.tgz`;
        writeFileSync(tgz, archive);
        await run("tar", ["-xzf", tgz, "-C", dir], () => {});
        pruneBrokenSymlinks(dir, log);
      });
    } else if (reused) {
      log(`Using the copy of ${url} we already fetched`);
      // Recorded so the saving from reusing a clone is visible in the data
      // rather than only claimed in a design document.
      await stages.skipped("clone");
    } else {
      await stages.around("clone", async () => {
        log(`Pulling ${url}`);
        await run("git", ["clone", "--depth", "1", url, dir], () => {});
      });
    }

    const raw = await stages.around("detect", async () => {
      log("Detecting stack…");
      return capture("npm", ["--prefix", AGENT, "run", "detect", "--silent", "--", dir, "--api"]);
    });
    const det = JSON.parse(raw.slice(raw.indexOf("{")));
    const s = det.stack;
    send({ type: "detected", stack: s, plan: det.provisionPlan });
    log(`Detected ${s.framework} · ${s.language} (${Math.round(s.confidence * 100)}%)`);
    if (s.database?.engine) log(`Provision ${s.database.engine} (via ${s.database.via})`);
    if (s.cache) log(`Provision ${s.cache} cache`);
    if (s.secretsNeeded?.length) log(`Will ask for secrets: ${s.secretsNeeded.join(", ")}`);

    // Agent-native plan. Instead of trusting the detector's hardcoded per-stack
    // recipes, let opencode READ the repo and decide the judgment calls: which
    // language, static vs server, the production run command, and whether it
    // needs a database. The detector still ran (its install/build commands feed
    // the static build lane and it is the fallback), but the agent overrides the
    // routing decisions here. Any planner failure keeps the detector's answer, so
    // planning is a pure upgrade that can never make a deploy worse.
    // The planner's app-specific build command, threaded to the runner's prepare
    // step (overrides its `npm run build` convention). Undefined ⇒ convention.
    let runnerBuild: string | undefined;
    // The plan's install command. Undefined ⇒ the runner's root-manifest
    // convention, which is right for a single-app repo and wrong for every
    // monorepo — see prepare.sh.
    let runnerInstall: string | undefined;
    // Whether the install command is the plan's rather than the detector's. A
    // command we were GIVEN is never rewritten; see runStatic.
    let installFromPlan = false;
    // Kept so the repair agent can be told what the platform decided.
    let activePlan: DeployPlan | null = null;
    // The planner was asked and did not answer. Distinct from "the planner never
    // ran": with PLANNER off the detector is the intended authority, and
    // refusing there would break every deploy that works today.
    let plannerFailed = false;
    // The content key these files hash to, kept so a plan can be remembered
    // against it once it has proved itself.
    let cacheKey: string | null = null;
    // Set only for a plan the planner actually produced this run. A configured
    // plan needs no cache and a cached one is already there.
    let worthCaching = false;

    // A repo that already says how to deploy itself does not need a model to
    // guess. `supersonic.json` is read first and, when present, replaces the
    // planner entirely — no inference, no 40-180s, and the same answer every
    // time. Written by the user's own coding agent, which knows the repo better
    // than a planner rediscovering it from `ls`.
    let configured: DeployPlan | null = null;
    // Kept for the sibling services declared alongside the primary.
    let appConfig: AppConfig | null = null;
    // True only for a config the USER wrote. An inferred one is our own reading
    // of the repo, and when our reading turns out to be unusable the planner is
    // the right next step — whereas a hand-written config that fails is the
    // user's to fix and must not be routed around. Same distinction the catch
    // below already draws for ConfigError, one level up.
    let configWasWritten = false;
    // What to call the plan's origin in the log. Never `supersonic.json` unless
    // there is one.
    let planSource = CONFIG_FILENAME;
    try {
      const cfg = readAppConfig(dir);
      if (cfg) {
        appConfig = cfg;
        configWasWritten = true;
        configured = planFromConfig(cfg);
        // A database is provisioned once for the whole app, and provisioning is
        // driven by the plan of the PRIMARY service — so a config where only a
        // sibling declares needsDB got no database at all. That is the normal
        // shape of the thing this feature exists for: a static frontend on "/"
        // and an API on "/api" that is the only part touching Postgres.
        if (cfg.services.some(usesDatabase)) configured.needsDB = true;
        log(`Using ${CONFIG_FILENAME} — no planning needed`);
      }
    } catch (e) {
      // Present and wrong is a hard stop. Falling back to the planner here would
      // make a typo look like the platform ignoring what the user asked for, and
      // they would have no way to tell the difference.
      throw e instanceof ConfigError ? new Error(e.message) : e;
    }

    // No config — but the repository may still be more than one app, and if it
    // is, no single-service plan can be right no matter who produced it. The
    // planner's own output type has one language, one run command and one port;
    // asked about a `frontend/` beside a `backend/` it can only answer with half
    // the repository, and on 1 Aug that is exactly what shipped: the detector
    // read the ROOT of such a repo as "Static site, 80%" — its highest-confidence
    // answer, and wrong — while pointing the same detector at each subdirectory
    // returns 95% and 90%, both right.
    //
    // So look before planning. This declines on every single-app repository, in
    // which case nothing below changes.
    if (!appConfig) {
      const inferred = await stages.around("infer-services", () => inferAppConfig(dir, detectStackIn));
      if (inferred) {
        appConfig = inferred;
        planSource = "inferred from the repo";
        configured = planFromConfig(inferred, undefined, planSource);
        if (inferred.services.some(usesDatabase)) configured.needsDB = true;
        log(`This repository is ${inferred.services.length} apps, not one:`);
        for (const svc of inferred.services) {
          const how = svc.start ? svc.start : `${svc.outputDir ?? "."}/ as static files`;
          log(`  ${servicePath(svc).padEnd(6)} ${svc.dir}  ·  ${svc.language}  ·  ${how}`);
        }
        // Named because inference is the platform's opinion, not the author's,
        // and the author must be able to overrule it without arguing with a log
        // line. `supersonic patch` already exists to deliver a file back.
        log(`Deploying them together behind one address. Write ${CONFIG_FILENAME} to pin or change this.`);
      }
    }

    // Before the planner, the detector, and anything that costs money.
    //
    // This used to be a log line inside ensureRunDeps — "the build will probably
    // fail on it — this is a platform limit, not your app" — and then the build
    // went ahead anyway, failed on exactly that, and handed the pip error to a
    // repair agent to rediscover from scratch. Knowing the answer and building
    // anyway is the expensive way to be right.
    //
    // Deliberately not left in ensureRunDeps: that runs inside a try whose catch
    // downgrades anything that is not `configWasWritten` to "Planner produced no
    // plan — deploying with the built-in detector instead", which would turn a
    // refusal into a fallback that builds the same app on the same runner. It
    // also only runs when a config or the planner is in play, so the pure
    // detector path was never gated at all.
    assertRuntimeSupported({
      pyproject: existsSync(join(dir, "pyproject.toml")) ? readFileSync(join(dir, "pyproject.toml"), "utf8") : null,
      packageJson: (() => {
        try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); } catch { return null; }
      })(),
    });

    if (configured || PLANNER_ENABLED) {
      try {
        let plan: DeployPlan;
        if (configured) {
          plan = configured;
        } else {
          // Ask the cache before asking the model. The planner re-derived the same
          // answer from the same bytes on every deploy — 87 seconds on 1 Aug to
          // conclude `node index.js` for a project that had not changed since the
          // last time it concluded `node index.js`.
          cacheKey = planKey(dir);
          const cached = cacheKey ? await getCachedPlan(cacheKey) : null;
          if (cached) {
            plan = cached;
            log("Plan unchanged since the last deploy of these files — skipping the planner");
          } else {
            log("Planning the deploy — the agent reads the repo…");
            plan = await planDeploy({ dir, log });
            worthCaching = true;
          }
        }
        activePlan = plan;
        if (typeof plan.build === "string") runnerBuild = plan.build;
        if (typeof plan.install === "string") runnerInstall = plan.install;
        if (plan.language === "node") s.runtime = "node";
        else if (plan.language === "python") s.runtime = "python";

        // The runner has a Node lane and a Python lane and nothing else. `other`
        // — Go, Rust, Java — used to fall through this block in silence and get
        // deployed by the detector, which worked but was nobody's decision: the
        // logs announced a plan and then quietly did something else with it. And
        // it was not merely cosmetic. `plan.run` was still taken, which both
        // overrides a repo's own Dockerfile and, if the detector had guessed
        // "node", hands a Go run command to the Node runner. A plan for a
        // language with no lane routes nothing.
        const routable = plan.language === "node" || plan.language === "python" || plan.static;
        if (!routable) {
          // Not `plan.language` — that is the raw enum value `other`, and printing
          // it next to a reason line naming the real language ("Go app with
          // go.mod") reads as the platform contradicting itself.
          log("Plan: not a Node or Python app — building it as a container (its Dockerfile, or buildpacks)");
        } else if (plan.static) {
          // `|| "dist"` was wrong, and wrong in the direction that breaks the
          // simplest possible site. A hand-written HTML page has no build and no
          // output directory — its output IS the repository root — so a planner
          // correctly answering "" or "." had that replaced by a `dist` which
          // does not exist, and the deploy died on an rsync from nowhere. Empty
          // is a real answer here, not a missing one. (static-build.ts already
          // carries the same lesson in the other direction, about `??` vs `||`.)
          //
          // Only a site that BUILDS can be assumed to build into `dist`; one that
          // doesn't is already the thing to publish.
          const stated = typeof plan.outputDir === "string" ? plan.outputDir.trim() : "";
          const hasBuild = Boolean(plan.build || s.buildCommand);
          s.serve = { mode: "static", outputDir: stated || (hasBuild ? "dist" : ".") };
          // The static lane builds with the DETECTOR's commands, so a plan that
          // supplies its own has to overwrite them here — the runner lane reads
          // plan.install/plan.build directly and this one does not.
          //
          // Without this, a config pointing at a subdirectory was half-obeyed:
          // its outputDir was honoured while its install and build were dropped,
          // so the detector's root-level `npm run build` ran and the deploy died
          // on `Did not find existing container at: frontend/dist` — a build that
          // never ran where the config said it would.
          if (typeof plan.install === "string") { s.installCommand = plan.install || null; installFromPlan = true; }
          if (typeof plan.build === "string") s.buildCommand = plan.build || null;
        } else {
          s.serve = { mode: "container" };
          if (plan.run && !runCmd) runCmd = plan.run;               // agent supplies the run cmd
        }
        // Held, not folded — and read for EVERY lane, which is the whole point of
        // it being out here.
        //
        // "`prisma migrate deploy` and friends are idempotent, so re-running on
        // each instance start is safe" was true of Prisma and of nothing else.
        // Folded into the start command a migration re-runs on every cold start
        // and every scale-out instance, CONCURRENTLY: Prisma takes an advisory
        // lock and survives that, Alembic does not. It also pays migration time
        // on every cold start and lets Cloud Run's startup probe kill the
        // container mid-migration. app-config.ts documented exactly this, and
        // then three call sites did it anyway.
        //
        // It runs once now, in its own Cloud Run job, before the pointer moves.
        // See lib/release-job.ts.
        releaseCmd = releaseFromPlan(plan);
        // needsDB is language-independent: a Go app with migrations needs its
        // database provisioned exactly as much as a Node one does. So is the
        // release — and it was the one thing here still asking the language.
        s.database = plan.needsDB ? { engine: "postgres", via: "agent" } : s.database;
        if (plan.envNeeded?.length) log(`App reads env: ${plan.envNeeded.join(", ")}`);
        log(`Plan ready: ${plan.reason || `${plan.language}${plan.static ? " static" : ""}`}`);
        if (routable && !plan.static) ensureRunDeps(dir, plan, log);
        // Remembered only here, at the far end of everything that can reject a
        // plan. Caching it the moment the planner returned would serve the next
        // deploy of the same bytes a plan this one had already refused.
        if (worthCaching && cacheKey) await putCachedPlan(cacheKey, plan);
      } catch (e) {
        if (configWasWritten) throw e;   // a config error is the user's to fix, not ours to route around
        // An INFERRED config is our own reading, not the author's instruction,
        // so a failure here is not theirs to fix. Drop it: deploying siblings
        // off a split whose primary never applied would put half an app behind
        // an address that serves the other half from a different plan.
        if (appConfig) {
          appConfig = null;
          log("The inferred split did not hold up — falling back to a single service.");
        }
        plannerFailed = true;
        // Keep whatever the planner did settle. A language without a run command
        // is not a deployable plan, but it IS the lane decision — and throwing it
        // away is how a repo the planner had read as Python ended up in the Node
        // runner, on the word of a detector that had read nothing.
        if (e instanceof PartialPlan && e.plan.language) {
          if (e.plan.language === "node" || e.plan.language === "python") {
            s.runtime = e.plan.language;
            log(`Planner settled the language (${e.plan.language}) but not how to start it — keeping the language.`);
          }
        }
        // Said out loud AND recorded on the deploy row, because it changes what
        // deployed this app. A planner that gave up quietly left someone reading a
        // failure from the fallback detector with no way to know that the plan
        // they had been told about never existed.
        const why = `Planner produced no plan (${e instanceof Error ? e.message : String(e)}) — deploying with the built-in detector instead`;
        log(why);
        setDeploy(slug, { stage: why });
      }
    }

    // A project that ships its own Dockerfile always takes a container lane,
    // whatever the detector concluded. The author was explicit.
    const hasDockerfile = existsSync(join(dir, "Dockerfile"));

    // When the planner gave up, the fallback is the detector — which is the
    // opinion the planner was called in to improve on. That is fine when there is
    // only one plausible answer and indefensible when there is more than one: on
    // 1 Aug a repository declaring BOTH Python and Node had Node picked for it,
    // silently, and the Python half was never mentioned again.
    //
    // So refuse instead of guessing. Deliberately NOT gated on the detector's
    // confidence: it reports 60% on a correct reading of a three-file Node app,
    // so a threshold would refuse healthy deploys while catching nothing.
    // A root Dockerfile is exempt — the author already said how to build this.
    if (plannerFailed && !hasDockerfile) {
      const why = refusalReason(readRepoFacts(dir), String(s.runtime || ""), CONFIG_FILENAME);
      if (why) throw new Error(`${AMBIGUOUS_STACK}: ${why}`);
    }
    const staticServe = !hasDockerfile && s.serve?.mode === "static"
      ? { outputDir: String(s.serve.outputDir || ".") }
      : null;

    // The prebuilt-runner lane owns server apps — Node or Python. A static SPA
    // stays on the instant static lane above. A Dockerfile normally keeps the
    // container build (the author was explicit) — EXCEPT when the agent hands us
    // a run command (--run): that means the agent decided how to run this, which
    // overrides a repo Dockerfile that may not even be self-contained (e.g. an
    // Nx `COPY dist/api` Dockerfile that assumes a prior build). Language is the
    // ONLY thing read here, from the runtime string — not the framework.
    const dockerfileOverridden = hasDockerfile && Boolean(runCmd);
    const runnerLang: "node" | "python" | null =
      RUNNER_ENABLED && !staticServe && (!hasDockerfile || dockerfileOverridden)
        ? (String(s.runtime || "").startsWith("node") ? "node"
          : String(s.runtime || "").startsWith("python") ? "python"
          : null)
        : null;

    // Now that the lane is known, the rest of the deploy is charged to it.
    stages = new StageRecorder(slug, staticServe ? "static" : runnerLang ? "runner" : hasDockerfile ? "generic" : "fast");

    if (staticServe) {
      log(`${s.framework} builds to a directory — publishing it without a container`);
      // Drop type-check/lint/test gates from the build script: the bundler
      // produces the artifact, the gates only fail the deploy on issues that
      // don't affect the running app. Our copy only — never the user's repo.
      try {
        const pkgPath = join(dir, "package.json");
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
          const original = pkg.scripts?.build;
          if (typeof original === "string") {
            const stripped = stripQualityGates(original);
            if (stripped !== original.trim()) {
              pkg.scripts.build = stripped;
              writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
              log(`Skipping build gates for the deploy: "${original}" → "${stripped}"`);
            }
          }
        }
      } catch { /* leave the build script as-is on any parse trouble */ }
    } else if (runnerLang) {
      log(`Using the prebuilt ${runnerLang} runner — no image to build`);
    } else if (!hasDockerfile && /vite|create react app|\bspa\b/i.test(s.framework)) {
      const outdir = /create react app/i.test(s.framework) ? "build" : "dist";
      writeFileSync(join(dir, "Dockerfile"), spaDockerfile(outdir));
      log(`SPA detected — building to static and serving ${outdir}/ on $PORT`);
    } else if (!hasDockerfile && isNextApp(dir)) {
      writeFileSync(join(dir, "Dockerfile"), nextDockerfile());
      log("Next.js detected — running the build, then serving on $PORT");
    }

    const primaryConfigService = appConfig ? primaryService(appConfig) : undefined;

    const extraEnv: string[] = url ? [`SUPERSONIC_REPO=${url}`] : [];
    // The literals the author committed, FIRST — so the platform's own values
    // below win a name they share. A user cannot declare a database variable
    // (parseAppConfig refuses every name databaseEnv writes), but they can
    // declare ALLOWED_HOSTS, and the platform is the only party that knows the
    // hostname this app is about to answer on.
    const declaredEnv = configEnv(primaryConfigService?.env, Object.keys(secrets));
    extraEnv.push(...declaredEnv.env);
    if (declaredEnv.env.length) log(`Setting from ${CONFIG_FILENAME}: ${declaredEnv.env.map((e) => e.slice(0, e.indexOf("="))).join(", ")}`);
    // Said out loud rather than silently resolved: a name in both places is a
    // user who believes one of the two values is live, and the one that is not
    // is the one they committed.
    if (declaredEnv.shadowed.length) log(`! ${declaredEnv.shadowed.join(", ")} is set both in ${CONFIG_FILENAME} and in your .env — the .env value is the one that lands`);
    // Where this app will live, known before it is built because the address is
    // derived from the slug rather than discovered from Cloud Run. An app was
    // previously told its port, its database and its bucket, and never its own
    // hostname — so every absolute URL it generated was the Cloud Run one.
    const facts: DeploymentFacts = {
      hostname: `${slug}.supersonic.cv`,
      scheme: "https",
      pathPrefix: appConfig ? servicePath(primaryService(appConfig)) : "/",
      siblingUrls: {},
    };
    for (const [k, v] of Object.entries(deploymentEnv(s.framework, facts))) extraEnv.push(`${k}=${v}`);
    let cloudsql: string | null = null;
    // The provisioned connection string. Held here rather than pushed straight
    // into the environment, so it can go to Secret Manager where the BUILD can
    // read it too — not only the running container.
    let databaseUrl = "";
    // Every database variable an app might read. Empty when it has no database.
    let dbEnv: string[] = [];
    // The app's own Postgres role, when it got one.
    let dbIsolated = false;
    let dbPassword = "";

    // Provisioning does not depend on the build, so it is started here and
    // awaited only where its results are actually needed — the database and
    // the bucket get created while Cloud Build is already working. Both
    // settle rather than reject: a missing bucket has always been survivable,
    // and starting them early must not change that.
    const pgPromise = s.database?.engine === "postgres"
      ? provisionPostgres(slug, log).then(
          (pg) => ({ ok: true as const, pg }),
          (e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
        )
      : null;
    const storagePromise = provisionStorage(slug, log).then(
      (bucket) => ({ ok: true as const, bucket }),
      (e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
    );
    if (s.database?.engine && s.database.engine !== "postgres") {
      log(`(${s.database.engine} provisioning not wired yet — deploying without it)`);
    }

    // The static lane needs neither, and waiting on them would hand back the
    // seconds this lane exists to save — UNLESS a sibling service does. The
    // database was created either way, but its connection details were only ever
    // wired up here, so a static frontend on "/" with an API on "/api" got a
    // Postgres instance nobody was told about: no proxy container, no
    // POSTGRES_SERVER, and an API that failed on a database it had been given.
    // That is the exact shape multi-service exists for.
    // Through usesDatabase, not `svc.needsDB` — v2 spells this `uses:
    // ["database"]`, and asking for one spelling here would strand a sibling API
    // that declared the other behind a static frontend, with a database
    // provisioned and no wiring to reach it. That is the bug usesDatabase was
    // written for, at the one call site the fix missed.
    const siblingNeedsDb = Boolean(appConfig && extraServices(appConfig).some(usesDatabase));
    if (!staticServe || siblingNeedsDb) {
      if (pgPromise) {
        log("Provisioning Postgres…");
        const r = await pgPromise;
        if (r.ok) {
          // Held, not pushed: it goes to Secret Manager below with the app's own
          // secrets, so the BUILD can read it too. Announcing "Injecting
          // DATABASE_URL" and then failing the build with "Cannot resolve
          // environment variable: DATABASE_URL" is precisely what this replaces.
          databaseUrl = r.pg.databaseUrl;
          cloudsql = r.pg.connectionName;
          // Every spelling of the same endpoint. DATABASE_URL alone is not enough:
          // plenty of apps never read it and require POSTGRES_SERVER or PGHOST.
          dbEnv = databaseEnv(r.pg);
          dbIsolated = r.pg.isolated;
          dbPassword = r.pg.password;
          log("Provisioned the database — connecting through a Cloud SQL proxy");
        } else {
          log(`! ${r.error} — deploying without a database`);
        }
      }
      log("Provisioning object storage…");
      const st = await storagePromise;
      if (st.ok) {
        extraEnv.push(`STORAGE_BUCKET=${st.bucket}`);
        extraEnv.push(`GOOGLE_CLOUD_PROJECT=${PROJECT}`);
      } else {
        log(`! storage skipped: ${st.error}`);
      }
    }

    // The app's own secrets go to Secret Manager, not into the revision spec.
    //
    // `--update-env-vars` writes values verbatim into the Cloud Run spec, where
    // they are readable by anyone with console or `run services describe` access
    // and retained in every past revision forever. That is the wrong home for a
    // Stripe key. It also leaves them unreachable from the BUILD, which is why an
    // app whose build reads its environment (Prisma 7 evaluates
    // `env('DATABASE_URL')` on every CLI command) could not deploy at all.
    //
    // Anything that cannot be stored falls back to a plain env var — the old
    // behaviour, and no worse than it was.
    // The split is delegated so that the one rule Cloud Run enforces — a name is
    // a secret or a plain variable, never both — lives somewhere it can be
    // tested. It was violated by an ordinary repo: the FastAPI template's `.env`
    // names POSTGRES_DB, which lands in Secret Manager, while the platform
    // publishes its own POSTGRES_DB for the database it just provisioned, and
    // gcloud refuses the revision outright. See lib/env-merge.ts.
    let secretEnv: Record<string, string> = { ...secrets };
    if (databaseUrl) {
      const merged = mergeDatabaseEnv(secrets, dbEnv);
      secretEnv = merged.secretEnv;
      extraEnv.push(...merged.plainEnv);
      // After the merge, not inside it. The app-facing names are whatever the
      // app happens to read and are the merge's business; this one is the
      // platform's own handle on the role's password, read back on the next
      // deploy so the role is not re-passworded out from under the revision
      // still serving traffic. It is ours, so no repo .env can collide with it.
      if (dbIsolated) secretEnv[DB_PASSWORD_SECRET] = dbPassword;
    }
    // The bundle key is minted here, before the secrets are stored, so it can go
    // with them.
    //
    // It used to be pushed onto extraEnv and set with --update-env-vars: the
    // plaintext AES key for the encrypted bundle, written verbatim into the
    // revision spec, readable by anyone with `run services describe`, and
    // retained in every past revision forever — in exactly the place
    // app-secrets.ts exists to keep values out of. The per-app bundle encryption
    // was defeated by the deploy that set it up: the encrypted bytes and the key
    // to decrypt them sat behind the same permission.
    let runnerCodeKey = "";
    if (runnerLang) {
      runnerCodeKey = randomBytes(32).toString("hex");
      secretEnv.SUPERSONIC_CODE_KEY = runnerCodeKey;
    }

    /**
     * The secrets the BUILD may mount, which is not the same set the RUNTIME gets.
     *
     * SUPERSONIC_CODE_KEY is the exception, and it has to be one: the prepare
     * step needs the literal key in order to encrypt the bundle, so
     * runnerPrepareConfig already writes it as a plain build variable. Passing it
     * as a secret as well means one name arrives twice, and Cloud Build refuses
     * the whole build — "step 0 has secret and non-secret env
     * SUPERSONIC_CODE_KEY". That is the same rule that POSTGRES_DB fell foul of
     * on the Cloud Run side: a name is a secret or it is plain, never both.
     */
    const buildSecrets = (refs: SecretRef[]) => refs.filter((r) => r.key !== "SUPERSONIC_CODE_KEY");

    let secretRefs: SecretRef[] = [];
    if (Object.keys(secretEnv).length) {
      const put = await putAppSecrets(slug, secretEnv, APP_RUNTIME_SA, log);
      secretRefs = put.stored;
      if (secretRefs.length) log(`Stored ${secretRefs.map((r) => r.key).join(", ")} in Secret Manager`);
      for (const k of put.skipped) {
        const v = secretEnv[k];
        if (k && v) extraEnv.push(`${k}=${v}`);
      }
    }

    // Runner lane: the code is uploaded to GCS and the runner image fetches it
    // at start. Point the container at that object via env — it rides the same
    // --set-env-vars below as DATABASE_URL, STORAGE_BUCKET and the secrets, so
    // a runner app comes up with its full environment wired.
    let runnerObject: string | null = null;
    if (runnerLang) {
      // Points at the READY bundle the prepare step produces (deps baked in),
      // not the raw source — so a starting instance fetches-and-runs.
      runnerObject = `ready/${slug}/${releaseId()}.tgz`;
      // Encrypted-bundle isolation: prepare encrypts the bundle with a random
      // per-deploy key before it lands in the shared bucket. The runtime SA reads
      // the encrypted bytes, but only THIS app holds the key to decrypt them, so
      // one app can never read another's source — no per-app IAM, no expiring URL.
      // The key itself is minted above and mounted from Secret Manager.
      extraEnv.push(`SUPERSONIC_CODE_BUCKET=${ASSETS_BUCKET}`);
      extraEnv.push(`SUPERSONIC_CODE_OBJECT=${runnerObject}`);
      // How to run it, from the agent. Without this the runner falls back to a
      // Node-only default; Python can't start at all — so the agent must supply it.
      if (runCmd) { extraEnv.push(`SUPERSONIC_RUN=${runCmd}`); log(`Run command: ${runCmd}`); }
      else log("No run command supplied — using the default (Node only; Python needs one)");
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
    // No --set-cloudsql-instances: that mounts the Unix socket, which is exactly
    // the thing being replaced. The proxy container reaches the instance itself.
    // `--update-env-vars`, never `--set-env-vars`: the latter replaces the whole
    // environment, so every redeploy silently deleted whatever the user had put
    // there with `supersonic env set` — their API keys and config — and the app
    // came back up broken in a way that looked like its own fault. Caught in the
    // end-to-end run: RESEND_API_KEY was set, listed by `env`, and gone from the
    // next revision. Merging can leave a stale key behind after a deploy stops
    // needing it; losing a customer's secret is the worse of the two.
    // Environment and secrets belong to the APP container, not the service, now
    // that a proxy container sits beside it — the proxy must not receive the
    // app's credentials, and Cloud Run requires these after a --container flag.
    const appFlags: string[] = [];
    if (extraEnv.length) appFlags.push(`--update-env-vars=^~~^${extraEnv.join("~~")}`);
    // Mounted by reference. `--update-secrets` merges, for the same reason
    // `--update-env-vars` does: a redeploy must not drop a key the previous one set.
    if (secretRefs.length) appFlags.push(`--update-secrets=${setSecretsFlag(secretRefs)}`);
    const labelPairs: string[] = [`supersonic-name=${friendlyName}`];
    if (ownerId) labelPairs.push(`supersonic-owner=${ownerId}`);
    deployFlags.push(`--update-labels=${labelPairs.join(",")}`);
    // The resource envelope, identical on every lane. `scale` becomes an
    // authored field in schema v2; until then every app gets the defaults,
    // which is still four lanes' worth more than the one that had them.
    const scale: Scale = DEFAULT_SCALE;
    // What "it works" means for THIS app. `strict` records whether the author
    // said so or the platform defaulted it: a declared `expect: 200` that comes
    // back 302 is a broken deploy and the field exists to say so, while an
    // undeclared default cannot be that strict — plenty of correct apps redirect
    // their root to /login.
    const primaryHealth = {
      health: primaryConfigService?.health ?? { path: "/", expect: 200 },
      strict: Boolean(primaryConfigService?.health),
      spaFallback: primaryConfigService?.spaFallback,
    };

    // With a Dockerfile, build it ourselves with a registry layer cache and
    // deploy the image — so an unchanged `npm install` is reused and redeploys
    // are dramatically faster. Which builder does it is BUILDER's call
    // (buildkit vs the Kaniko default); see lib/build-config.ts. Without a
    // Dockerfile, fall back to buildpacks.
    const IMAGE = `${REGION}-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy/${slug}`;
    const useDockerBuild = existsSync(join(dir, "Dockerfile"));
    const builder = selectedBuilder();
    if (useDockerBuild) writeFileSync(join(dir, "cloudbuild.yaml"), cachedBuildConfig(IMAGE, builder, slug));
    // Which Cloud Build is ours. Every command below that can start one feeds
    // its raw output through builds.note(), so a failure is read back from the
    // build this deploy started rather than from whatever built most recently.
    const builds = buildWatcher(slug);
    const buildLine = (l: string) => { builds.note(l); const out = buildLogLine(l); if (out) log(out); };

    // The argv actually sent, kept so the deploy can be checked against what the
    // author asked for rather than against what the code intended.
    let lastArgv: string[] = [];
    // The environment of the revision Cloud Run just created, read back out of
    // the response it already returns. What the app HAS, which is not the same
    // as what this deploy sent — both env and secret flags merge, so a value set
    // by an earlier deploy is still live and still correct.
    let revisionEnv: { name: string; fromSecret: boolean }[] = [];
    let hasRevision = false;
    const attempt = async (args: string[]): Promise<{ ok: boolean; url?: string; error?: string }> => {
      lastArgv = args;
      const hb = setInterval(() => log("deploying…"), 6000);
      builds.reset();
      try {
        const o = await gcloudDeploy(args, log, (l) => builds.note(l));
        clearInterval(hb);
        const svc = JSON.parse(o.slice(o.indexOf("{")));
        // Read back from the response that already exists rather than by
        // describing the service again: an extra round trip could disagree with
        // the revision this deploy just made, and then the check would be
        // reporting on something else.
        try {
          const containers = svc?.spec?.template?.spec?.containers ?? [];
          const appContainer = containers.find((c: { name?: string }) => c.name === "app") ?? containers[0];
          revisionEnv = (appContainer?.env ?? []).map((e: { name: string; valueFrom?: unknown }) => ({
            name: e.name,
            fromSecret: Boolean(e.valueFrom),
          }));
          hasRevision = true;
        } catch { /* an unreadable spec leaves the environment unverifiable, not failed */ }
        const liveUrl = svc?.status?.url ?? "";
        if (liveUrl) {
          // Grant before probing: a sealed app 403s the control plane's own
          // probe until the binding exists.
          if (SEAL_APPS) await grantInvokers(slug, log);
          log("verifying the app responds…");
          const probe = await probeApp(liveUrl, log, SEAL_APPS, primaryHealth);
          if (!probe.ok) return { ok: false, error: probe.reason };
        }
        return { ok: true, url: liveUrl };
      } catch (e) {
        clearInterval(hb);
        let err = e instanceof Error ? e.message : String(e);
        if (/build failed/i.test(err)) {
          log("fetching the real build log for the agent…");
          const buildLog = await builds.error();
          if (buildLog) err = `Cloud Build failed. Actual build output:\n${buildLog}`;
        }
        return { ok: false, error: err };
      }
    };
    /**
     * Run the one-shot release, ONCE, before anything moves.
     *
     * Not in Cloud Build: app-secrets.ts gets DATABASE_URL into the build, but
     * the Cloud SQL proxy is a Cloud Run SIDECAR, and Cloud Build has nothing
     * listening on 127.0.0.1:5432. The build holds a connection string pointing
     * at a closed port. Prisma passes only because `prisma generate` never
     * connects; `manage.py migrate` hangs to the 1200s timeout.
     *
     * A failure returns here and the caller never reaches `gcloud run deploy` —
     * no revision, no traffic move, and the previous revision keeps serving the
     * schema it was written for.
     */
    const runRelease = async (spec: {
      lane: "runner" | "container" | "buildpack";
      service: string; image?: string; source?: string; env: string[]; release: string;
    }): Promise<{ ok: boolean; error?: string }> => {
      if (!spec.release.trim()) return { ok: true };
      const job = {
        lane: spec.lane, service: spec.service, region: REGION, project: PROJECT,
        serviceAccount: APP_RUNTIME_SA || null,
        labels: [`supersonic-name=${friendlyName}`],
        image: spec.image, source: spec.source,
        release: spec.release, env: spec.env,
        secrets: secretRefs.length ? setSecretsFlag(secretRefs) : null,
        scale, cloudsql,
      };
      try {
        await stages.around("release", async () => {
          log(`Release: ${spec.release}`);
          try {
            await capture("gcloud", releaseJobArgs(job));
          } catch (e) {
            // Configuring the job is ours to get right — a role, a flag, a
            // region. There is nothing in the repository for an agent to fix,
            // so it short-circuits on the rule IAM_FAILURE already carries.
            throw new Error(`${IAM_FAILURE}: could not configure the release job — ${e instanceof Error ? e.message : String(e)}`);
          }
          await run("gcloud", releaseExecuteArgs(job), log);
        });
        return { ok: true };
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        if (why.includes(IAM_FAILURE)) return { ok: false, error: why };
        // `--wait` reports THAT it failed and not one line of why. The traceback
        // is in the job's own logs — the same gap fetchContainerError closed for
        // a crash-looping revision.
        const detail = await capture("gcloud", releaseLogsArgs(job)).catch(() => "");
        return { ok: false, error: `Release failed — the previous revision is still serving.\n${why}${detail ? `\n--- release log ---\n${detail}` : ""}` };
      }
    };

    /**
     * Static lane: build the assets, copy them to GCS, then move the pointer.
     * No image is assembled, nothing is pushed to Artifact Registry, no Cloud
     * Run service is created and no revision has to roll out — which is the
     * entire reason this lane exists.
     */
    const runStatic = async (out: { outputDir: string }): Promise<{ ok: boolean; url?: string; error?: string }> => {
      const release = releaseId();
      const prefix = releasePrefix(slug, release);
      const destination = `gs://${ASSETS_BUCKET}/${prefix}`;
      const needsBuild = Boolean(s.installCommand || s.buildCommand);

      try {
        if (needsBuild) {
          await stages.around("build", async () => {
            log("Building assets…");
            const hb = setInterval(() => log("building…"), 8000);
            writeFileSync(join(dir, "cloudbuild.yaml"), staticBuildConfig({
              // A command the plan supplied is run exactly as written.
              //
              // These flags are a convenience for the command the DETECTOR
              // generates, and appending them to somebody else's is wrong twice
              // over: `pip install -r requirements.txt --no-audit` is not a
              // command, and `(cd frontend && npm ci) --prefer-offline` is a
              // syntax error — a subdirectory command is a subshell, and nothing
              // can be appended after its closing paren. Both were produced by
              // trying to be helpful with a string we did not write.
              installCommand: !s.installCommand
                ? null
                : installFromPlan
                  ? s.installCommand
                  : `${s.installCommand} --prefer-offline --no-audit --no-fund`,
              buildCommand: s.buildCommand,
              outputDir: out.outputDir,
              destination,
              // The dependency tarball a build writes may only ever be read
              // back by the tenant that produced it: it is not a dependency
              // graph, it is one project's node_modules including whatever
              // its postinstall scripts left in there.
              namespace: ownerWorkspace ?? ownerId,
              slug,
            }));
            builds.reset();
            try {
              await run("gcloud", ["builds", "submit", dir, "--region", REGION, "--project", PROJECT, "--config", join(dir, "cloudbuild.yaml")], buildLine);
            } finally { clearInterval(hb); }
          });
        } else {
          // Nothing to build — the directory already is the site, so it goes
          // straight up from here and skips Cloud Build entirely.
          await stages.around("upload", async () => {
            log("Uploading…");
            const source = join(dir, out.outputDir);
            // Checked before the copy, because `rsync` from a directory that is
            // not there fails in a way nothing downstream can explain: this lane
            // runs no Cloud Build, so there is no build log to fall back on and
            // the deploy reports `gcloud exited 1` with no cause anywhere. Saying
            // which directory was expected is the whole diagnosis.
            if (!existsSync(source)) {
              throw new Error(
                `this site has no \`${out.outputDir}\` directory to publish.\n` +
                `The files to serve should be at the repository root, or in the directory the build writes.`
              );
            }
            await runOrExplain("gcloud", ["storage", "rsync", "-r", source, destination, "--project", PROJECT]);
          });
        }
      } catch (e) {
        const buildLog = await builds.error();
        const reason = buildLog || (e instanceof Error ? e.message : String(e));
        return { ok: false, error: `Build failed:\n${reason}` };
      }

      // A green Cloud Build is not evidence that anything was uploaded — the
      // step that copies the assets can exit 0 having copied nothing, which
      // is exactly how a pointer came to name a release that does not exist.
      // Read the release back before it is allowed to go live.
      try {
        await stages.around("verify", async () => {
          log("Checking the build…");
          await assertReleaseUploaded(prefix, destination, log);
        });
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }

      // Last, and only now: the release is complete, so it may be named. A
      // failure above leaves the previous release live and untouched.
      await writePointer(slug, release);
      log(`Published release ${release}`);
      // The proxy routes by looking up apps.run_url, so a static app points
      // at the shared static server. The proxy tells that server which app a
      // request is for via x-supersonic-slug, because it drops Host on the
      // way through and every static app shares this one upstream.
      const upstream = await staticServiceUrl();
      if (!upstream) {
        return { ok: false, error: `${STATIC_SERVICE} has no URL — is the static server deployed?` };
      }
      return { ok: true, url: upstream };
    };

    /**
     * Deploy one of an app's NON-primary services.
     *
     * A second service exists for one reason: the app has two things that both
     * have to listen. A Next.js frontend doing SSR is itself a server and cannot
     * be mounted inside FastAPI, so "Next + Python" is genuinely two Cloud Run
     * services — and it is a shape people build constantly.
     *
     * Deliberately narrower than the primary path. A sibling is always a runner
     * service: no static lane (a static sibling is just files the primary can
     * serve), no Dockerfile lane, no domain mapping, and no database provisioning
     * of its own — it shares the app's. What it gets is its own prepared bundle,
     * built from the same source with its own install/build, and its own URL,
     * which the proxy then routes to by path prefix.
     */
    const deploySibling = async (svc: ServiceConfig): Promise<{ ok: boolean; url?: string; error?: string; name: string }> => {
      const label = (svc.name || servicePath(svc).replace(/[^a-z0-9]+/gi, "") || "svc").toLowerCase();
      const name = cloudRunName(`${slug}-${label}`);
      const plan = planFromConfig({ services: [svc] }, svc, planSource);
      const lang: "node" | "python" | null =
        plan.language === "node" ? "node" : plan.language === "python" ? "python" : null;
      if (!lang) {
        return { ok: false, name, error: `service "${label}" is ${plan.language}; a second service must be node or python` };
      }
      if (!plan.run) return { ok: false, name, error: `service "${label}" has no start command` };

      const image = lang === "python" ? RUNNER_PYTHON_IMAGE : RUNNER_NODE_IMAGE;
      const release = `${label}-${releaseId()}`;
      const key = randomBytes(32).toString("hex");
      // A sibling gets its own release job, for the same reason and by the same
      // route as the primary — its own image, its own bundle, its own command.
      const startCmd = plan.run;
      const siblingRelease = plan.preRun?.filter(Boolean).join(" && ") ?? "";

      try {
        await stages.around("prepare", async () => {
          log(`Preparing ${label} on the ${lang} runner…`);
          if (secretRefs.length) await grantBuildAccess(secretRefs, BUILD_SA, log);
          writeFileSync(join(dir, "cloudbuild.yaml"), runnerPrepareConfig({
            image, bucket: ASSETS_BUCKET, slug, release, codeKey: key,
            build: plan.build, install: plan.install, language: lang, secretEnv: buildSecrets(secretRefs),
          }));
          const hb = setInterval(() => log(`preparing ${label}…`), 8000);
          builds.reset();
          try {
            await run("gcloud", ["builds", "submit", dir, "--region", REGION, "--project", PROJECT, "--config", join(dir, "cloudbuild.yaml")], buildLine);
          } finally { clearInterval(hb); }
        });
      } catch (e) {
        const buildLog = await builds.error();
        return { ok: false, name, error: `Preparing ${label} failed:\n${buildLog || (e instanceof Error ? e.message : String(e))}` };
      }

      // Its own environment: the shared app env, plus the pointers to ITS bundle.
      // Not the primary's — those name a different tarball and a different key.
      //
      // And its own deployment facts, which is where the prefix finally matters:
      // a sibling is the service that IS mounted under one. Django on /api
      // building its URLs as though it were at the root is the whole reason
      // FORCE_SCRIPT_NAME exists, and the primary's facts say nothing about it.
      const siblingFacts: DeploymentFacts = { ...facts, pathPrefix: servicePath(svc) };
      const siblingDeployment = deploymentEnv(svc.framework, siblingFacts);
      const env = [
        ...extraEnv
          .filter((e) => !e.startsWith("SUPERSONIC_CODE_") && !e.startsWith("SUPERSONIC_RUN="))
          // The primary's facts must not leak into the sibling: they name a
          // different prefix, and a stale SUPERSONIC_PATH_PREFIX is worse than
          // none because the app would trust it.
          .filter((e) => !Object.keys(siblingDeployment).some((k) => e.startsWith(`${k}=`)))
          // Nor the primary's declared literals, for the same reason: `env` is
          // per SERVICE in the schema, so the frontend's NODE_ENV has no
          // business on the API.
          .filter((e) => !declaredEnv.env.some((d) => e.slice(0, e.indexOf("=")) === d.slice(0, d.indexOf("=")))),
        // …and its own.
        ...configEnv(svc.env, Object.keys(secrets)).env,
        ...Object.entries(siblingDeployment).map(([k, v]) => `${k}=${v}`),
        `SUPERSONIC_CODE_BUCKET=${ASSETS_BUCKET}`,
        `SUPERSONIC_CODE_OBJECT=ready/${slug}/${release}.tgz`,
        `SUPERSONIC_RUN=${startCmd}`,
      ];
      // Service-level flags only; the argv builder scopes the rest to the app
      // container and appends the proxy. A sibling shares the app's database,
      // so it needs its own proxy beside it.
      const siblingFlags = [
        "--region", REGION, SEAL_APPS ? "--no-allow-unauthenticated" : "--allow-unauthenticated",
        "--project", PROJECT, "--format=json",
      ];
      if (APP_RUNTIME_SA) siblingFlags.push(`--service-account=${APP_RUNTIME_SA}`);
      siblingFlags.push(`--update-labels=supersonic-name=${friendlyName},supersonic-parent=${slug}`);
      // The sibling's bundle key goes to Secret Manager for the same reason the
      // primary's does — it is the key to that sibling's source, and a revision
      // spec is a place people read. Its own secret, because its own bundle:
      // sharing the primary's would mean either key decrypts either bundle.
      const siblingKeySecret = await putAppSecrets(name, { SUPERSONIC_CODE_KEY: key }, APP_RUNTIME_SA, log);
      const siblingRefs = [...secretRefs.filter((r) => r.key !== "SUPERSONIC_CODE_KEY"), ...siblingKeySecret.stored];
      // Anything Secret Manager refused falls back to a literal, which is the
      // old behaviour and no worse — but it is said out loud rather than assumed.
      if (siblingKeySecret.skipped.length) env.push(`SUPERSONIC_CODE_KEY=${key}`);

      const siblingApp: string[] = [];
      if (siblingRefs.length) siblingApp.push(`--update-secrets=${setSecretsFlag(siblingRefs)}`);
      siblingApp.push(`--update-env-vars=^~~^${env.join("~~")}`);

      const relS = await runRelease({ lane: "runner", service: name, image, env, release: siblingRelease });
      if (!relS.ok) return { ok: false, name, error: relS.error };
      log(`Deploying ${label} on the prebuilt ${lang} runner…`);
      try {
        const args = deployArgs({
          lane: "runner", service: name, serviceFlags: siblingFlags, appFlags: siblingApp,
          image, port: 8080, scale, cloudsql,
        });
        const out = await gcloudDeploy(args, log, (l) => builds.note(l));
        const url = JSON.parse(out.slice(out.indexOf("{")))?.status?.url ?? "";
        if (!url) return { ok: false, name, error: `${label} deployed but reported no URL` };
        // Sealed apps refuse the control plane's own probe until the binding
        // exists, exactly as for the primary.
        if (SEAL_APPS) await grantInvokers(name, log);
        // Then WAIT for that binding to take effect before calling this live.
        //
        // Cloud Run IAM does not apply instantly to a service created seconds
        // earlier, and the deploy used to report the app live as soon as the
        // sibling had a URL. The first person to open it got a Google 403 from a
        // deploy that had just announced success — observed on the first
        // two-service deploy, and gone ~30s later on its own. The primary never
        // showed this because it is probed before go-live; the sibling was not.
        for (let attempt = 0; ; attempt++) {
          // A sibling is checked against its OWN declared health path. `/api`
          // answering 404 at its root is normal for a service mounted under a
          // prefix, and the primary's expectations say nothing about it.
          const probe = await probeApp(url, log, SEAL_APPS, {
            health: svc.health ?? { path: "/", expect: 200 },
            strict: Boolean(svc.health),
            spaFallback: svc.spaFallback,
          });
          if (probe.ok) break;
          if (attempt >= 5 || !/cannot invoke it/i.test(probe.reason ?? "")) {
            return { ok: false, name, error: `${label} is not answering: ${probe.reason ?? "no response"}` };
          }
          await new Promise((r) => setTimeout(r, 5000));
        }
        return { ok: true, name, url };
      } catch (e) {
        return { ok: false, name, error: `Deploying ${label} failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    };

    const runDeploy = async (): Promise<{ ok: boolean; url?: string; error?: string }> => {
      if (staticServe) return runStatic(staticServe);
      if (runnerLang && runnerObject) {
        // No image is built. A one-time prepare step installs deps + builds on
        // the runner image (warm cache) and uploads a ready-to-run bundle; the
        // deploy then points the shared runner image at that bundle. So install
        // happens ONCE here, not on every instance start.
        const image = runnerLang === "python" ? RUNNER_PYTHON_IMAGE : RUNNER_NODE_IMAGE;
        const release = runnerObject.split("/").pop()!.replace(/\.tgz$/, "");
        try {
          await stages.around("prepare", async () => {
            log(`Preparing on the ${runnerLang} runner (install + build once — no image)…`);
            // Cloud Build runs as its own service account, so it needs its own
            // grant — the runtime account's access does not carry over.
            if (secretRefs.length) await grantBuildAccess(secretRefs, BUILD_SA, log);
            writeFileSync(join(dir, "cloudbuild.yaml"), runnerPrepareConfig({ image, bucket: ASSETS_BUCKET, slug, release, codeKey: runnerCodeKey, build: runnerBuild, install: runnerInstall, language: runnerLang, secretEnv: buildSecrets(secretRefs) }));
            const hb = setInterval(() => log("preparing…"), 8000);
            builds.reset();
            try {
              await run("gcloud", ["builds", "submit", dir, "--region", REGION, "--project", PROJECT, "--config", join(dir, "cloudbuild.yaml")], buildLine);
            } finally { clearInterval(hb); }
          });
        } catch (e) {
          const buildLog = await builds.error();
          return { ok: false, error: `Prepare failed:\n${buildLog || (e instanceof Error ? e.message : String(e))}` };
        }
        const rel = await runRelease({ lane: "runner", service: slug, image, env: extraEnv, release: releaseCmd });
        if (!rel.ok) return { ok: false, error: rel.error };
        log(`Deploying on the prebuilt ${runnerLang} runner…`);
        // Real Node apps ship a full node_modules and run `next start`; the Cloud
        // Run default of 512 MiB OOM-kills them at startup (measured: 564 MiB used
        // before the app even binds $PORT), which shows up as a flaky "didn't start
        // on $PORT". That measurement is why DEFAULT_SCALE is what it is — and now
        // every lane gets it, not only this one.
        return attempt(deployArgs({
          lane: "runner", service: slug, serviceFlags: deployFlags, appFlags,
          image, port: 8080, scale, cloudsql,
        }));
      }
      if (useDockerBuild) {
        log(`Building with layer cache (${builder}) — the first build warms it, later ones are fast…`);
        const hb = setInterval(() => log("building…"), 8000);
        const btail: string[] = [];
        const onBuild = (l: string) => { btail.push(l); if (btail.length > 60) btail.shift(); buildLine(l); };
        builds.reset();
        try {
          await run("gcloud", ["builds", "submit", dir, "--region", REGION, "--project", PROJECT, "--config", join(dir, "cloudbuild.yaml")], onBuild);
        } catch {
          clearInterval(hb);
          const buildLog = await builds.error();
          const reason = buildLog
            || btail.filter((l) => /error|invalid|denied|must|logging|permission|quota|not found/i.test(l)).slice(-6).join("\n")
            || btail.slice(-6).join("\n");
          return { ok: false, error: reason ? `Build failed:\n${reason}` : "the build failed — check the logs" };
        }
        clearInterval(hb);
        const relC = await runRelease({ lane: "container", service: slug, image: `${IMAGE}:latest`, env: extraEnv, release: releaseCmd });
        if (!relC.ok) return { ok: false, error: relC.error };
        return attempt(deployArgs({
          lane: "container", service: slug, serviceFlags: deployFlags, appFlags,
          image: `${IMAGE}:latest`, scale, cloudsql,
        }));
      }
      const buildpack = (containerFlags?: string[]) => deployArgs({
        lane: "buildpack", service: slug, serviceFlags: deployFlags, appFlags,
        source: dir, scale, cloudsql, containerFlags,
      });
      // This lane pays for its build twice: `run jobs deploy --source` runs
      // buildpacks again, because there is no image to reuse — the service's
      // image only exists after `run deploy`, which is after the pointer moves.
      // The alternative is folding the migration back into `start`, which is the
      // bug this replaced.
      if (releaseCmd.trim()) log("Buildpack lane: the release step builds the source a second time — this one is slower.");
      const relB = await runRelease({ lane: "buildpack", service: slug, source: dir, env: extraEnv, release: releaseCmd });
      if (!relB.ok) return { ok: false, error: relB.error };
      let res = await attempt(buildpack());
      if (!res.ok && /clear-base-image/i.test(res.error ?? "")) {
        log("switching build type — clearing base image and retrying…");
        res = await attempt(buildpack(["--clear-base-image"]));
      }
      return res;
    };

    log(`Deploying ${slug} to Cloud Run…`);
    const firstAttempt = stages.start("deploy");
    let result = await runDeploy();
    await stages.end(firstAttempt, result.ok ? "ok" : "failed");

    // Did the revision come out carrying what the author asked for?
    //
    // Every bug that cost a deploy today was a field the platform accepted,
    // validated, printed back, and then did not apply: `env` set on nothing,
    // `release` never run on the container lane, `uses: ["database"]`
    // provisioning no database. All three had passing unit tests over them,
    // because those tests asked what the CODE contained rather than what the
    // deploy came out holding.
    //
    // Checked only on success. A failed deploy has a cause worth reporting, and
    // burying it under "the platform did not apply your config" would be trading
    // a real error for a derived one. Thrown rather than returned, so it reaches
    // the outer handler instead of the repair agent — there is nothing in the
    // user's repository to fix.
    if (result.ok && appConfig) {
      const resolvedApp = resolveFrom(appConfig, configWasWritten ? "config" : "inferred");
      const primaryEnvelope = buildEnvelope(resolvedApp.services[0], resolvedApp);
      assertReached(primaryEnvelope, {
        revisionEnv,
        hasRevision,
        releaseCommand: releaseCmd,
        argv: lastArgv,
        hasDatabase: Boolean(databaseUrl),
      });
    }
    if (!result.ok) {
      log(`✕ ${result.error}`);
      // The container started and then crashed: our error is only the symptom
      // ("didn't start on $PORT"). Pull its real crash log so the user — and the
      // repair agent — see the actual cause instead of guessing (which is how a
      // 2-minute failure turns into a 10-minute redeploy loop chasing a fake fix).
      if (/didn'?t start on|failed to start and listen/i.test(result.error ?? "")) {
        const crash = await fetchContainerError(slug);
        if (crash) {
          log(`Actual container error:\n${crash}`);
          result.error = `${result.error}\n\n--- actual container startup log ---\n${crash}`;
        }
      }
      // A permissions failure is ours, not the repo's — the repair agent would
      // burn redeploys on it and then bury the real cause in its summary. A
      // refusal to guess is the same shape: the repo is fine, the question was
      // ours, and there is nothing in the code for an agent to fix.
      // Classified in code, not by a model. Before this, only IAM_FAILURE and
      // AMBIGUOUS_STACK short-circuited: a gcloud crash, a quota, a connection
      // refused, a database-name collision were all handed to a repair agent
      // with edit access to the customer's repository and asked to fix them.
      // There is nothing there to fix in any of those cases, so the agent
      // invents work — it once invented an app, wrote a fake .env, deleted a
      // migrate script, and spent 428k tokens reaching `gcloud exited 1`.
      const blame = classify(result.error);
      if (blame.blame === "platform") {
        if (blame.reason && blame.reason !== result.error) log(blame.reason);
        setDeploy(slug, { status: "failed", error: result.error ?? "deploy failed" });
        if (ownerId && ownerWorkspace) await markAppFailed(slug).catch(() => {});
        send({ type: "error", message: result.error });
        return;
      }
      // The auto-fix agent is a Pro feature. Basic gets a paste-ready prompt
      // for its own coding agent instead of us fixing the code in the cloud.
      if (!limits.autoFix) {
        setDeploy(slug, { status: "failed", error: result.error ?? "deploy failed" });
        if (ownerId && ownerWorkspace) await markAppFailed(slug).catch(() => {});
        log("Deploy failed — here's a fix to hand your coding agent (auto-fix is on Pro).");
        send({
          type: "error",
          message: result.error,
          fixPrompt: fixPrompt(slug, result.error ?? "deploy failed"),
          upgrade: true,
        });
        return;
      }
      log("Repair agent taking over — reading the repo, fixing, retrying…");
      // Timed separately: a deploy the agent rescues is a very different
      // experience from one that worked first time, and a median that mixes
      // the two hides how often we are paying for it.
      const useOpencode = process.env.DEPLOY_ENGINE === "opencode";
      if (useOpencode) log("Repair engine: opencode");
      // Snapshot first, so whatever the agent changes can be handed back. Its
      // edits live in a scratch copy that is deleted when the deploy ends, so
      // until now a rescued app left the user's own folder still broken — and
      // their next deploy shipped the same code again.
      const snapshotted = await snapshotSources(dir);
      const repair = stages.start("repair-agent");
      const fixed = useOpencode
        ? await opencodeRepair({ dir, slug, initialError: result.error ?? "unknown", plan: activePlan, redeploy: runDeploy, log })
        : await repairDeploy({ dir, slug, initialError: result.error ?? "unknown", redeploy: runDeploy, log });
      await stages.end(repair, fixed.ok ? "ok" : "failed");
      if (fixed.ok) {
        result = { ok: true, url: fixed.url };
        log(`Agent fixed it (${fixed.changes.join(", ")})`);
        // The fix, in a form that can leave this machine. Printed into the log
        // rather than kept in a summary, because a description of a change is not
        // a change: "Fixed: package.json" tells nobody what to type. Now that
        // `logs` reads the event log back, this is reachable after the fact.
        const patch = snapshotted ? await repairPatch(dir) : null;
        if (patch) {
          // Sent as its own event, not as log lines: `supersonic logs` prefixes
          // every line with a time and a severity, so a patch printed there
          // cannot be piped into `git apply`.
          send({ type: "patch", patch });
          log("This fix is only on the server — your folder still has the old code. To apply it:");
          log(`  supersonic patch ${slug} | git apply`);
        } else {
          log("Heads up: this fix was made on the server, not in your folder — your next deploy will send the old code again.");
        }
      }
      else {
        setDeploy(slug, { status: "failed", error: fixed.summary });
        if (ownerId && ownerWorkspace) await markAppFailed(slug).catch(() => {});
        send({ type: "error", message: fixed.summary });
        return;
      }
    }
    // `result.url` is the Cloud Run URL, and printing it as "Live at" was a lie
    // in both of the cases that actually occur. A sealed app REFUSES that URL by
    // design — clicking it gets a Google 404 — and a static app does not have one
    // at all: the value is the shared static server every static app points at,
    // so every one of them printed the same address as though it were theirs. It
    // also leaks the project's Cloud Run hash. Shown only when it is genuinely
    // the app's own reachable address.
    if (!SEAL_APPS && !staticServe && result.url) log(`Live at ${result.url}`);

    // Any sibling services, once the primary is up.
    //
    // In this order deliberately: the primary owns the app's URL, so a repo that
    // declares two services still has something serving on it if a sibling fails.
    // A sibling failure is reported and does NOT fail the deploy — an app whose
    // frontend is live and whose API did not come up is in a worse state if we
    // also tear the frontend down.
    let routes: { path: string; url: string }[] | null = null;
    if (appConfig && result.ok) {
      const extras = extraServices(appConfig);
      if (extras.length) {
        const built: { path: string; url: string }[] = [
          { path: servicePath(primaryService(appConfig)), url: result.url ?? "" },
        ];
        const refused: string[] = [];
        for (const svc of extras) {
          const r = await deploySibling(svc);
          if (r.ok && r.url) {
            built.push({ path: servicePath(svc), url: r.url });
            log(`${servicePath(svc)} → ${r.name}`);
          } else {
            log(`! ${r.error} — ${servicePath(svc)} will not be served`);
            refused.push(`${servicePath(svc)}: ${r.error ?? "no reason given"}`);
          }
        }
        // Recorded on the deploy row, not only logged.
        //
        // A sibling that does not come up leaves an app that looks completely
        // healthy — the frontend is live on its own address, and every request
        // to /api quietly falls through to it, which for an SPA means the
        // index.html of the very page that is asking. The one line saying why
        // is a log line, and the log is a window: on the FastAPI template the
        // build output shares a single timestamp and pushes it out entirely, so
        // the deploy that was hardest to debug is exactly the one whose reason
        // is gone by the time anybody looks.
        // Awaited: the very next writes set status live, and a fire-and-forget
        // stage that lands after them is a reason nobody sees.
        if (refused.length) await setDeploy(slug, { stage: `${refused.length} service(s) not served — ${refused.join(" · ")}` });
        if (built.length > 1) routes = built;
      }
    }
    // The two routing models are mutually exclusive: a per-app domain
    // mapping points straight at Cloud Run, which a sealed app refuses.
    if (SEAL_APPS || staticServe) {
      // A static app has no service of its own to map a name onto — the
      // proxy routes it by apps.run_url to the shared static server, the
      // same way it routes everything else. So the visibility rules apply
      // with no special case, and there is no per-app mapping to create.
      log(`Live at ${slug}.supersonic.cv`);
    } else {
      await createDomainMapping(slug, log);
    }
    setDeploy(slug, { status: "live", url: result.url });
    if (ownerId && ownerWorkspace) {
      await markAppLive(slug, result.url ?? "", null, routes);
      // Not awaited: the deploy is finished, and a thumbnail must never hold it.
      void requestThumbnail(slug, result.url ?? "");
    }
    // A static app's run_url is the shared static server, which is useless to
    // show someone — their app lives at its own name, reached through the proxy.
    send({ type: "done", slug, url: SEAL_APPS || staticServe ? `https://${slug}.supersonic.cv` : result.url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setDeploy(slug, { status: "failed", error: msg });
    // Anything thrown after the row was created — a clone failure, bad
    // detector output, a provisioning error — would otherwise leave the app
    // stuck at status 'deploying' forever.
    if (ownerId && ownerWorkspace) await markAppFailed(slug).catch(() => {});
    send({ type: "error", message: msg });
  } finally {
    // ONE place, on every exit — including the three failures that `return`
    // from inside the try above. Notifying at each ending instead would be the
    // seventh implementation of "the deploy is over", and a later eighth would
    // silently send nothing with no test failing.
    //
    // It reads the row rather than being handed a result, so the mail says
    // exactly what the dashboard says. Awaited so a job that exits the moment
    // this returns cannot cut the send off mid-flight; it can never throw.
    await notifyDeployFinished(slug, ownerId);
  }
}

