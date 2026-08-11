// Everything below moved here from app/api/deploy/route.ts unchanged; see runDeploy.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, existsSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairDeploy } from "@/lib/agent";
// The agent backend is chosen by DEPLOY_AGENT (codex by default, opencode one
// variable away). The pipeline imports the switch, never a backend, so it does
// not learn which CLI ran — see lib/agents/types.ts.
import { agentRepair, agentName, planDeploy, PartialPlan, type DeployPlan } from "@/lib/agents";
import { checkPlanDeps, RUNTIME_UNSUPPORTED, RUNTIME_VERSIONS } from "@/lib/plan-deps";
import { repoRuntime, runnerServes, runtimeRouting } from "@/lib/repo-runtime";
import { generateDockerfile, baseImage, dockerignore, manifestPaths, DockerfileError, type DockerfileInput } from "@/lib/dockerfile";
import { readRepoFacts, refusalReason } from "@/lib/repo-facts";
import { readBuildHints, rememberBuildHints, aptPackagesIn } from "@/lib/build-hints";
import { detect } from "@/lib/detect";
import { planKey, getCachedPlan, putCachedPlan } from "@/lib/plan-cache";
import { snapshotSources, repairPatch } from "@/lib/repair-diff";
import { putAppSecrets, setSecretsFlag, grantBuildAccess, readAppSecret, allAppSecrets, type SecretRef } from "@/lib/app-secrets";
import { cloudRunName } from "@/lib/slug";
import { SCHEDULER_SA } from "@/lib/identities";
import { chooseNode, nodeFaultFor, placeApp, placementFor, runningOnNode, runtimeOf, setRuntime, unplaceApp } from "@/lib/fleet";
import { deployTargetFor } from "@/lib/deploy-target";
import { appLogFilter } from "@/lib/log-filter";
import { buildAppSpec, memoryBytes, cpuShares, type AppSpec, type AgentProcess } from "@/lib/fleet-spec";
import { awaitRunning, chooseRuntime, fleetPlacementWanted, fleetProbe, placeOnFleet } from "@/lib/fleet-place";
import { recordRelease, setDesired, desiredRelease } from "@/lib/reconcile";
import { rollback, deleteRunService, getLogs } from "@/lib/gcloud";
import { readAppConfig, planFromConfig, ConfigError, CONFIG_FILENAME, primaryService, extraServices, servicePath, usesDatabase, releaseCommand, type ServiceConfig, type AppConfig, type HealthConfig } from "@/lib/app-config";
import { inferAppConfig, type DetectedStack } from "@/lib/infer-services";
import { mergeDatabaseEnv, configEnv, restateDatabaseAt } from "@/lib/env-merge";
import { pgConfig } from "@/lib/pg-config";
import { dbNameForSlug } from "@/lib/db";
import { createAppRecord, markAppLive, markAppFailed, getAppBySlug } from "@/lib/apps";
import { requestThumbnail } from "@/lib/thumbnail";
import { setDeploy } from "@/lib/deploys";
import { notifyDeployFinished } from "@/lib/deploy-notify";
import { releaseId, releasePrefix, pointerPath, ASSETS_BUCKET } from "@/lib/static-release";
import { listObjectNames, readObjectText, writeObject, describeServiceRest, resolveImageDigest, imageExposedPort } from "@/lib/gcp-rest";
import { take as takeClone } from "@/lib/clone-cache";
import { staticBuildConfig } from "@/lib/static-build";
import { verifyRelease } from "@/lib/verify-release";
import { StageRecorder, ACTIVATION_STAGE } from "@/lib/stages";
import { stripQualityGates } from "@/lib/build-gates";
import { type Limits } from "@/lib/entitlements";
import { countIfUnder, claimFreeFix } from "@/lib/usage";
import { agentLimitMessage } from "@/lib/plan-copy";
import { cachedBuildConfig, selectedBuilder, mountsBuildSecrets, buildLogLine, CACHE_MISS_NOISE, runnerPrepareConfig, appBuildTag, cloudBuildIdFrom, RAILPACK_PLAN } from "@/lib/build-config";
import { CLOUD_RUN_DB, databaseUrlFor, type DbAddress } from "@/lib/db-address";
import { deployArgs, databaseEnv, databaseEnvNames, needsServiceRecreate, DB_HOST, DB_PORT, withScale, choosePort, DEFAULT_PORT, type Lane, type Scale } from "@/lib/lanes";
import { verifyApp } from "@/lib/verify-app";
import { ensureAppRole, DB_PASSWORD_SECRET } from "@/lib/pg-role";
import { classify } from "@/lib/deploy-errors";
import { causeOf, failureSentence, FailureRecorder } from "@/lib/deploy-failures";
import { releaseJobArgs, releaseExecuteArgs, releaseLogsArgs, releaseFromPlan, proxyWait } from "@/lib/release-job";
// frameworkBuildEnv is deliberately not wired here yet: build-time variables
// have to reach the Cloud Build config, not the revision, and that is Phase 7d.
import { deploymentEnv } from "@/lib/framework-env";
import { resolveFrom, laneFor, type DeploymentFacts } from "@/lib/resolve";
import { sidecarFor, sidecarEnv, dependencyRefusal } from "@/lib/dependencies";
import { wantsRepoRootContext, buildOwner } from "@/lib/dockerfile-context";
import { publicUrlBuildArgs, publicUrlEnvArgs, ENV_FILENAMES } from "@/lib/public-url-args";
import { railpackConfig, railpackPrepareArgs } from "@/lib/railpack";
import { detectRelease, RELEASE_FILES } from "@/lib/release-detect";
import { readProcfile } from "@/lib/procfile";
import { mergeProcfile, resolveProcess, resolveProcesses, type ResolvedProcess } from "@/lib/processes";
import { planProcesses, orphans, isServiceless, listWorkerPoolsArgs, listProcessJobsArgs, type LiveProcess } from "@/lib/process-plan";
import { buildEnvelope, assertReached } from "@/lib/envelope";
import { planResources, type Declared } from "@/lib/resources";

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

/**
 * The address of the fleet's load balancer.
 *
 * Empty means there is nowhere to send traffic, so placement is skipped whatever
 * `FLEET_PLACEMENT` and `FLEET_APPS` say — an app placed on a node nothing
 * routes to is strictly worse than an app left on Cloud Run. Which apps are
 * placed at all is `fleetPlacementWanted`'s question, not this file's.
 */
const FLEET_LB = process.env.FLEET_LB ?? "";
// The identity the prepare step actually runs as, and therefore what must be able
// to read the app's secrets.
//
// NOT `<project-number>@cloudbuild.gserviceaccount.com`, which is the obvious
// guess and is wrong here: builds submitted without an explicit service account
// run as the project's DEFAULT COMPUTE account. Guessing cost a deploy that
// failed with "Permission 'secretmanager.versions.access' denied" on a secret
// that existed and was granted — to somebody else.
// `CLOUD_BUILD_RUN_AS` first, because a secret has to be granted to whoever the
// build actually runs as. Granting the default compute account while the build
// runs as somebody else is the same failure this comment was written for, with
// the two identities swapped.
const BUILD_SA = process.env.CLOUD_BUILD_RUN_AS
  || process.env.CLOUD_BUILD_SERVICE_ACCOUNT
  || "540236122367-compute@developer.gserviceaccount.com";

/**
 * The identity a build RUNS as, when we are willing to name one.
 *
 * `RUN <install>` is customer code. `npm ci` runs `postinstall`, and `needs` adds
 * `apt-get` as an expected instruction — and until now every build ran as the
 * project's default compute account, whose danger this file already describes
 * 2,000 lines below about the RUNTIME container: it "carries run.admin,
 * storage.admin and artifactregistry.writer. That gives every customer's code —
 * arbitrary code we agreed to run — the ability to delete the control plane, read
 * every other customer's source out of the build bucket, and overwrite another
 * app's image."
 *
 * That was true of the runner prepare, the buildpack lane and static. The
 * collapse makes it the single path for 100% of apps, which is what turns a
 * standing exposure into the obvious next thing to fix.
 *
 * Empty means "say nothing and inherit the default", which is exactly today's
 * behaviour — so this is additive, and revertible by unsetting one variable.
 */
const BUILD_RUN_AS = process.env.CLOUD_BUILD_RUN_AS ?? "";
/** `--service-account` for `builds submit`, or nothing at all. */
const buildIdentityArgs = (): string[] =>
  (BUILD_RUN_AS ? [`--service-account=projects/${PROJECT}/serviceAccounts/${BUILD_RUN_AS}`] : []);
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
      appLogFilter(slug, { minSeverity: "ERROR" }),
      "--project", PROJECT, "--limit", "25", "--freshness", "10m",
      "--format=json", "--order=asc",
    ]);
    // Both runtimes, because they differ: a Cloud Run entry carries textPayload,
    // and an entry the ops agent shipped from a node carries jsonPayload.message.
    // Reading only textPayload returned null for every fleet app while looking
    // exactly like an app that logged nothing.
    const lines = (JSON.parse(out) as any[])
      .map((e) => String(e.textPayload ?? e.jsonPayload?.message ?? ""))
      .map((l) => l.trim())
      .filter(Boolean)
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

/**
 * The variable NAMES the live service already carries, or none when there is no
 * service yet.
 *
 * Names only, never values: the question is whether something supplied a value,
 * and reading the value to answer it would pull a credential into a log-adjacent
 * code path for no gain. A first deploy has no service and answers with an empty
 * list, which is correct rather than an error.
 */
async function liveEnvNames(slug: string): Promise<string[]> {
  const s = await describeServiceRest(slug).catch(() => null);
  const containers = s?.spec?.template?.spec?.containers ?? [];
  return containers.flatMap((c: { env?: { name?: string }[] }) =>
    (c.env ?? []).map((e) => e.name).filter((n): n is string => Boolean(n)),
  );
}

/**
 * Whether the live service's containers are NAMED, or null when it does not exist.
 *
 * `deployArgs` needs this because the flat and scoped argv shapes are not
 * interchangeable on an existing service, and which one a service has is a fact
 * about the service rather than about the lane deploying to it. A repo that gains
 * a `supersonic.json` can move lane — buildpack to runner is one config line —
 * and the lane's own default then disagrees with what is already deployed.
 */
async function liveContainerShape(service: string): Promise<boolean | null> {
  const s = await describeServiceRest(service).catch(() => null);
  const containers = s?.spec?.template?.spec?.containers;
  if (!Array.isArray(containers) || containers.length === 0) return null;
  return containers.some((c: { name?: string }) => Boolean(c.name));
}

/**
 * Whether this app has no live Cloud Run service yet — a first deploy.
 *
 * The cold/warm signal `deploy_stages` has never had, and half of what makes the
 * build-path decision measurable rather than arguable. A first deploy cannot hit
 * any cache by construction, so a cache hit rate computed without separating them
 * out is measuring the wrong population — and a first deploy is also the moment
 * someone decides whether this product is fast, which is the number that settles
 * whether a 2-4 minute cold build is affordable.
 *
 * Null rather than a guess in the two cases where the answer is not knowable:
 * when the API call fails, and for the static lane, which publishes to GCS and
 * has no service of its own to be absent. `apps.release_hash` cannot stand in for
 * any of this — it is null for everything built in the cloud, which is every
 * deploy this measures.
 *
 * Telemetry must never be the reason a deploy fails, so this cannot throw.
 */
async function isFirstDeploy(service: string): Promise<boolean | null> {
  try {
    return (await describeServiceRest(service)) ? false : true;
  } catch {
    return null;
  }
}

/**
 * The app's processes, from its Procfile and its config, or [] when it declares none.
 *
 * Read ONCE per deploy and threaded, rather than resolved where it is needed.
 * Two readers would be two answers to "does this app have a web process", and
 * that question decides whether a Cloud Run service is deployed at all — the most
 * expensive thing in this file to be of two minds about.
 *
 * Never throws. A malformed process set is the author's to fix and is reported by
 * `deployProcesses` with the field named; failing here would fail the whole deploy
 * on a file the app may not even have meant for us.
 */
function readProcesses(dir: string, config: ServiceConfig | undefined, log: (l: string) => void): ResolvedProcess[] {
  try {
    // The service's own directory, not always the repo root: a config with
    // `dir: "backend"` runs its commands there, so that is where its Procfile is.
    // Reading the root's would give a monorepo's frontend Procfile to its API.
    const fromFile = readProcfile(join(dir, config?.dir ?? "."));
    return resolveProcesses(mergeProcfile(config?.processes, fromFile));
  } catch {
    return [];
  }
}

/**
 * The image the live service is running.
 *
 * The buildpack lane's image is built by `run deploy --source` and named by Cloud
 * Run, so it cannot be known before the deploy and must not be guessed. Reading
 * it back is one API call; the alternative — handing each worker `--source` — pays
 * for the whole build again per process, on a lane whose release job already pays
 * for it twice and says so.
 */
async function liveContainerImage(service: string): Promise<string | null> {
  const s = await describeServiceRest(service).catch(() => null);
  const image = s?.spec?.template?.spec?.containers?.[0]?.image;
  return typeof image === "string" && image ? image : null;
}

/**
 * What this app declares to Cloud Run when the fleet is running it: nothing.
 *
 * Named rather than written inline as `[]`, because an empty array at a call
 * site reads like an omission and this is a decision. `planProcesses` plans no
 * steps for it, and the orphan pass then removes every worker-pool and job the
 * app has on Cloud Run — which is the whole point. Two live copies of one
 * process is the defect class the fleet fork exists to end.
 */
const FLEET_OWNS_PROCESSES: ResolvedProcess[] = [];

/**
 * Deploy the app's workers and crons, and remove the ones it no longer declares.
 *
 * The imperative half of the process model. Every decision is made by the pure
 * planner in lib/process-plan.ts and every argv by lib/process-deploy.ts, so what
 * is left here is a loop — which is the point of the split: the risk lives in
 * about thirty lines and the rules stay under test.
 *
 * Nothing in here can fail the deploy. A worker that does not come up leaves an
 * app whose web service is live, and tearing that down would make the situation
 * strictly worse; the same rule a sibling already follows. Failures are logged
 * AND written to the deploy row, because the log is a window — on a build with
 * dense output the one line that says why scrolls out of it.
 */
async function deployProcesses(o: {
  slug: string;
  dir: string;
  lane: Lane;
  image?: string;
  source?: string;
  env: string[];
  secrets: string | null;
  cloudsql: string | null;
  labels: string[];
  config?: ServiceConfig;
  processes: ResolvedProcess[];
  log: (l: string) => void;
}): Promise<void> {
  const { slug, log } = o;

  // Resolved once, by `readProcesses`, and handed in — because whether this app
  // has a `web` process decided whether a Cloud Run service was deployed at all,
  // long before this runs. Re-reading here could disagree with that decision.
  //
  // The same read is repeated in strict mode purely to report WHY a malformed set
  // was empty: `readProcesses` swallows the error so a bad Procfile cannot fail a
  // deploy, and swallowing it silently is the defect this plan is named after.
  const { processes } = o;
  try {
    resolveProcesses(mergeProcfile(o.config?.processes, readProcfile(join(o.dir, o.config?.dir ?? "."))));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    log(`! ${why}`);
    await setDeploy(slug, { stage: `processes not deployed — ${why}` });
    return;
  }

  // A Procfile `release:` line is read and does not run yet: the release phase
  // has its own path (lib/release-job.ts) that already knows the two things easy
  // to get wrong there, and a second implementation is the defect this plan is
  // named after. Said out loud rather than dropped, and it names the field that
  // does work today.
  if (processes.some((p) => p.kind === "release") && !releaseCommand(o.config ?? {})) {
    log(`! the Procfile declares a "release" process and it did NOT run — put it in ${CONFIG_FILENAME} as "release" instead`);
  }

  // Without an artifact there is nothing to run, and a worker deployed from a
  // source tree would build the app a third time. Loud rather than silent: the
  // processes did not deploy and the deploy row says why.
  if (!o.image && !o.source && processes.some((p) => p.kind === "worker" || p.kind === "cron")) {
    const why = "could not resolve the image the app was deployed with";
    log(`! processes not deployed — ${why}`);
    await setDeploy(slug, { stage: `processes not deployed — ${why}` });
    return;
  }

  const d = {
    service: slug, lane: o.lane, region: REGION, project: PROJECT,
    image: o.image, source: o.source, serviceAccount: APP_RUNTIME_SA || undefined,
    labels: o.labels, env: o.env, secrets: o.secrets, cloudsql: o.cloudsql,
  };
  const steps = planProcesses(processes, d, { schedulerServiceAccount: SCHEDULER_SA });

  const failed: string[] = [];
  for (const step of steps) {
    // Notes before the attempt: a field that will not be emitted is something the
    // author should hear about whether or not the deploy then works.
    for (const note of step.notes) log(`! ${note}`);
    try {
      log(`Deploying ${step.label}…`);
      await capture("gcloud", step.deploy);
      if (step.schedule) {
        // Update-then-create, because `scheduler jobs create` is not
        // create-or-update: it fails ALREADY_EXISTS on the second deploy of an
        // unchanged app, which would fail every redeploy of a CRM on a cron that
        // was already correct.
        await capture("gcloud", step.schedule.update)
          .catch(() => capture("gcloud", step.schedule!.create));
      }
      log(`${step.label} is running`);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // A missing role is not the app's problem and must never reach the repair
      // agent — the same rule IAM_FAILURE already encodes for the invoker binding.
      //
      // Not hypothetical: the first CRM to reach this step created its Cloud Run
      // job and then could not create the schedule that triggers it, because the
      // deploy identity carries run.admin, cloudsql.admin, secretmanager.admin and
      // storage.admin and no cloudscheduler role at all. The app was correct, the
      // argv was correct, and a one-line permission gap surfaced as a generic
      // failure with nothing pointing at the fix.
      const denied = /PERMISSION_DENIED|does not have permission|forbidden|\b403\b/i.test(raw);
      const why = denied && step.kind === "cron"
        ? `${IAM_FAILURE}: the deploy identity cannot manage Cloud Scheduler. `
          + `Grant roles/cloudscheduler.admin to ${SCHEDULER_SA} — nothing in the app can fix this.`
        : raw;
      log(`! ${step.label} did not deploy: ${why}`);
      await setDeploy(slug, { stage: `${step.label} did not deploy — ${why}` });
      failed.push(step.label);
    }
  }

  // What the app HAS that its config no longer describes.
  //
  // Listed every time rather than only when processes are declared, and the two
  // list calls are the cost of that. The alternative is skipping the pass for an
  // app that declares none — which is exactly the app that just deleted its last
  // worker, so the one case where cleanup matters most is the one that would be
  // skipped. Two reads on a deploy that takes minutes is the right trade.
  const live: LiveProcess[] = [];
  const [pools, jobs] = await Promise.all([
    capture("gcloud", listWorkerPoolsArgs(d)).catch(() => ""),
    capture("gcloud", listProcessJobsArgs(d)).catch(() => ""),
  ]);
  for (const [out, primitive] of [[pools, "worker-pool"], [jobs, "job"]] as const) {
    for (const name of out.split("\n").map((l) => l.trim()).filter(Boolean)) live.push({ name, primitive });
  }

  for (const gone of orphans(live, steps, d)) {
    log(`Removing ${gone.label} — it is no longer in the config`);
    for (const argv of gone.deletes) {
      // Best-effort and in order. A schedule that is already gone is not a
      // failure, and stopping here would leave the job it pointed at behind.
      await capture("gcloud", argv).catch((e) => log(`! could not remove ${gone.name}: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  // Thrown so the STAGE records a failure, after the cleanup pass has run.
  //
  // Caught by the caller, which is what keeps a failed worker from failing the
  // deploy — but a stage that reports "ok" while a worker never started would put
  // the platform back in the position this plan is about: telemetry that agrees
  // with the code rather than with what happened. Every individual failure has
  // already been logged and written to the deploy row; this is the summary.
  if (failed.length) throw new Error(`${failed.length} of ${steps.length} processes did not deploy: ${failed.join(", ")}`);
}

/**
 * Whether this app's database actually exists on the shared instance.
 *
 * A fact about the cloud, not about the config. The resource engine needs it to
 * tell "this app never had a database" from "this app HAD one and no longer
 * declares it" — and only the second is worth saying out loud, because it is the
 * one where somebody's data is sitting there unwired and they should know.
 *
 * Unknown counts as absent: a failed read must not produce a log line telling
 * someone their data was kept when we could not confirm any exists.
 */
async function databaseExists(slug: string): Promise<boolean> {
  try {
    await capture("gcloud", ["sql", "databases", "describe", dbNameForSlug(slug),
      "--instance=supersonic-shared-pg", "--project", PROJECT, "--format=value(name)"]);
    return true;
  } catch {
    return false;
  }
}

/** Create a per-app database on the shared Cloud SQL instance and return a socket DATABASE_URL. */
function provisionPostgres(slug: string, log: (l: string) => void, at: DbAddress): Promise<{ databaseUrl: string; connectionName: string; user: string; password: string; dbName: string; isolated: boolean }> {
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
      const databaseUrl = databaseUrlFor(role, dbName, at);
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
/** One place that names an app's bucket, so existence and creation cannot disagree. */
function bucketName(slug: string): string {
  return `supersonicdeploy-${slug}`.slice(0, 63);
}

/**
 * Whether the app's bucket exists, and whether anything is in it.
 *
 * The second half is what makes gating storage safe. Every app deployed before
 * the gate existed was given a bucket whether it asked or not, so "undeclared"
 * cannot be read as "unused" — an app that has been writing uploads without ever
 * declaring `uses: ["bucket"]` would lose STORAGE_BUCKET on its next deploy and
 * start failing at runtime on a variable it never asked for and always had.
 *
 * Unknown counts as in use. Detaching on a failed read would be a silent
 * behaviour change decided by a transient error, and keeping a bucket wired for
 * one more deploy costs nothing.
 */
async function bucketState(slug: string): Promise<{ exists: boolean; inUse: boolean }> {
  const name = bucketName(slug);
  try {
    await capture("gcloud", ["storage", "buckets", "describe", `gs://${name}`, "--project", PROJECT, "--format=value(name)"]);
  } catch {
    return { exists: false, inUse: false };
  }
  try {
    const out = await capture("gcloud", ["storage", "ls", `gs://${name}/**`, "--project", PROJECT]);
    return { exists: true, inUse: Boolean(out.trim()) };
  } catch (e) {
    // "matched no objects" is an empty bucket, which is the one case that may be
    // let go. Anything else is unknown, and unknown keeps it.
    const m = e instanceof Error ? e.message : String(e);
    return { exists: true, inUse: !/matched no|no url|not found|404/i.test(m) };
  }
}

async function provisionStorage(slug: string, log: (l: string) => void): Promise<string> {
  const bucket = bucketName(slug);
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
export async function probeApp(
  url: string,
  log: (l: string) => void,
  sealed: boolean,
  health?: { health: HealthConfig; strict: boolean; spaFallback?: boolean },
  // Seams, for the test below. Nothing in production passes either.
  opts: { mint?: (audience: string) => Promise<string>; sleepImpl?: (ms: number) => Promise<void> } = {},
): Promise<{ ok: boolean; reason?: string }> {
  // A sealed app cannot be reached without a token, so mint it outside the check
  // below: a token failure means the check did not happen, and saying so beats
  // returning a pass we never verified. A public app needs no token at all.
  //
  // It said that and then returned `{ ok: true }` — a pass it had never
  // verified. So a deploy whose app never came up shipped, was marked live, and
  // reported "verified" to everything downstream, on the strength of a check
  // that did not run. The comment was right and the code did the opposite.
  //
  // Retried first, because most of what breaks here is transient. A single
  // metadata hiccup is not evidence about the app, and turning one into a
  // failed deploy would trade a silent false pass for a noisy false failure.
  //
  // Then FAILED, not skipped — and marked IAM_FAILURE, which is already in
  // PLATFORM_MARKERS. That routing is what makes failing closed safe here:
  // `classify` reads the marker, blames the platform, rolls back and tells the
  // user, and never hands the repair agent a customer's repository over a
  // credential of ours. Without the marker this same change would send an LLM
  // to "fix" a repo that has nothing wrong with it.
  let auth: Record<string, string> = {};
  if (sealed) {
    const mint = opts.mint ?? idTokenFor;
    const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let lastErr = "";
    let token = "";
    for (let i = 0; i < 3 && !token; i++) {
      if (i) await sleep(1000 * i);
      try {
        token = await mint(url);
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    if (!token) {
      log(`! could not mint an ID token to check ${url} after 3 attempts — ${lastErr}`);
      return {
        ok: false,
        reason: `IAM_FAILURE: could not mint an ID token to check this app, so the deploy was never verified — ${lastErr}`,
      };
    }
    auth = { Authorization: `Bearer ${token}` };
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
/**
 * Drop the app's hostname mapping.
 *
 * The `remove` half of the domain resource, and the case it exists for: an app
 * that HAD a web process and becomes worker-only leaves a hostname pointing at a
 * Cloud Run service that no longer serves. Nothing removed it, because nothing
 * owned the question — the deploy path only ever created mappings.
 *
 * Quiet and best-effort. An app that never had one is the common case, and a
 * mapping that cannot be removed is not a reason to fail a deploy that otherwise
 * worked.
 */
async function removeDomainMapping(slug: string, log: (l: string) => void): Promise<void> {
  try {
    await capture("gcloud", ["beta", "run", "domain-mappings", "describe", "--domain", `${slug}.supersonic.cv`,
      "--region", REGION, "--project", PROJECT, "--format=value(metadata.name)"]);
  } catch {
    return; // there is no mapping, which is the state we wanted
  }
  try {
    await capture("gcloud", ["beta", "run", "domain-mappings", "delete", "--domain", `${slug}.supersonic.cv`,
      "--region", REGION, "--project", PROJECT, "--quiet"]);
    log(`Removed the address ${slug}.supersonic.cv — this app no longer has a web process`);
  } catch (e) {
    log(`! could not remove ${slug}.supersonic.cv: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Clear a Cloud SQL attachment the app no longer has any use for.
 *
 * The drift the resource engine exists to end, in its original form. Nothing in
 * the deploy path sets this annotation any more — `deployArgs` deliberately does
 * not (`--set-cloudsql-instances` mounts a Unix socket, which apps that build a
 * connection URL out of parts cannot express), and the proxy runs as a sidecar
 * instead. So every annotation still out there is residue from the
 * managed-database era, and nothing has ever removed one.
 *
 * It is not inert residue. `describeService` reports a "Database" card off it,
 * so an app with no database is told it has one; and `execCommand` builds its
 * one-off jobs with `--set-cloudsql-instances` read straight from it, so the
 * drift propagates into a second feature. Tonight it also carried a container
 * shape across a lane change and broke a deploy outright.
 *
 * Only when the app has NO platform database. An app that has one gets its
 * connection from the sidecar and the annotation is equally stale — but clearing
 * it there is a change to a working app's spec for no benefit this step needs,
 * and that belongs with the wholesale spec-replace rather than here.
 */
async function clearStaleCloudSql(slug: string, log: (l: string) => void): Promise<void> {
  const live = await describeServiceRest(slug).catch(() => null);
  const ann = live?.spec?.template?.metadata?.annotations?.["run.googleapis.com/cloudsql-instances"];
  if (!ann) return;
  try {
    await capture("gcloud", ["run", "services", "update", slug, "--clear-cloudsql-instances",
      "--region", REGION, "--project", PROJECT, "--quiet"]);
    log(`Cleared a leftover Cloud SQL attachment (${ann}) — this app has no platform database`);
  } catch (e) {
    log(`! could not clear the leftover Cloud SQL attachment: ${e instanceof Error ? e.message : String(e)}`);
  }
}

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
  /**
   * Which deploy this is, so every stage it records can be grouped by it.
   *
   * The same id the route used for its handoff stages, so the wait a person
   * experienced is one span rather than two. Optional: a caller that does not
   * supply one still records stages, and the reader falls back to the time
   * window it used before the column existed.
   */
  runId?: string;
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
  // "unknown", not "generic": no lane has been chosen yet, and `generic` used to
  // mean both that and the Dockerfile lane — one string for two facts, which is
  // what LANE_BLIND_STAGES in lib/analytics/attempts.ts exists to work around.
  let stages = new StageRecorder(slug, "unknown", undefined, undefined, undefined, { runId: input.runId });
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
      stages = new StageRecorder(slug, "static", undefined, undefined, undefined, { runId: input.runId });
      // Wrapped in the ACTIVATION stage, which this path has never emitted.
      //
      // `publishPrebuilt` writes `unpack`, `upload` and `verify` and then this
      // block returns — so a `--prebuilt` deploy produced no `deploy` row, ever.
      // Activation is `min(ended_at) FILTER (WHERE stage = 'deploy' AND outcome =
      // 'ok')` over the whole table, so every prebuilt app has read as never
      // having gone live since the metric was written, and the query could not
      // fail to say so: a missing row is a well-formed null.
      //
      // Around the publish rather than after it, so `ended_at` is the moment the
      // app was actually reachable — which is what the metric means. The inner
      // stages nest inside this one, which `coveredMs` already handles by unioning
      // intervals rather than summing them.
      await stages.around(ACTIVATION_STAGE, async () => {
        await publishPrebuilt({ dir, archive, slug, hash: prebuiltHash, log, send, stages });
        setDeploy(slug, { status: "live", url: `https://${slug}.supersonic.cv` });
        if (ownerId && ownerWorkspace) {
          const staticUrl = (await staticServiceUrl()) ?? "";
          // A static site is nothing but a web page, so `true` — and `null` for
          // routes, which this call never had and must not acquire by having a
          // later argument slide into its place.
          await markAppLive(slug, staticUrl, prebuiltHash || null, null, true);
          void requestThumbnail(slug, staticUrl);
        }
      });
      send({ type: "done", slug, url: `https://${slug}.supersonic.cv` });
      return;
    }

    if (isUpload && archive) {
      await stages.around("unpack", async () => {
        log("Unpacking your project…");
        const tgz = `${dir}.tgz`;
        writeFileSync(tgz, archive);
        await run("tar", ["-xzf", tgz, "-C", dir], () => {});
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

    // Here, where the three ways of getting the source meet — not inside the
    // upload branch, which is where this used to live.
    //
    // The reasoning written down for `pruneBrokenSymlinks` is about the CLI
    // excluding `.venv` from an upload and thereby stranding the links that point
    // into it. True, and it made the fix look like a property of uploads. It is
    // not: a `git clone` of a repo that COMMITTED those symlinks produces exactly
    // the same dangling links, because `.venv` is not in the repository either.
    // `fastapi/full-stack-fastapi-template` — the very repo that prompted the
    // original fix — commits `.agents/skills/fastapi` and `.agents/skills/sqlmodel`
    // as symlinks into `.venv`, so deploying it from a URL crashed
    // `gcloud builds submit` on 10 Aug with the same unattributable
    // `gcloud crashed (FileNotFoundError)` the fix was written to prevent, twice,
    // while the fix sat three branches away.
    pruneBrokenSymlinks(dir, log);

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
    // What the REPOSITORY asked for, read from its own files.
    //
    // This used to be `assertRuntimeSupported`, which THREW: an app pinning a
    // version the runner does not have was refused outright and told to "widen
    // requires-python, or wait for the runner to move. Nothing in the code can fix
    // this one." That is the platform holding one Python and one Node and asking
    // every business to fit them.
    //
    // Now it routes instead. A pinned runtime the runner cannot serve sends the
    // app down the buildpack lane, which reads `.python-version`, `runtime.txt`,
    // `requires-python`, `.nvmrc` and `engines.node` itself — so the app gets the
    // version it asked for and the platform never picks one. The platform's whole
    // involvement is one yes/no question it is deliberately pessimistic about.
    const read = (f: string) => existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : null;
    const pinned = repoRuntime({
      pythonVersion: read(".python-version"),
      runtimeTxt: read("runtime.txt"),
      pyproject: read("pyproject.toml"),
      nvmrc: read(".nvmrc"),
      packageJson: (() => {
        try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); } catch { return null; }
      })(),
    });
    const runtimePinned = Boolean(pinned && !runnerServes(pinned));
    if (pinned && runtimePinned) log(runtimeRouting(pinned));

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
            plan = await planDeploy({ dir, log, slug, runId: input.runId });
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
    // A pinned runtime we cannot otherwise provide gets a Dockerfile written for it.
    //
    // This is what makes "any language, any version" true rather than aspirational.
    // Both limits the platform had come from the same place — every build path we
    // had needs a runtime somebody prepared in advance. The runner has two images
    // because someone built two Dockerfiles. Google's builder has no Rust, Elixir,
    // Deno or Bun, and its Python is 3.13 and 3.14 only, which is how an app
    // pinning 3.12 failed AFTER being routed to it correctly.
    //
    // Docker Hub already holds an official image for every language at every
    // version any of them published, so `FROM python:3.12` needs nobody to prepare
    // anything. Written into OUR copy of the repo — the author's tree is not ours
    // to edit — and it then takes the container lane, which already knows how to
    // build an image with a layer cache and deploy it. No new lane, no new
    // failure modes; the app simply stops being told what it may run on.
    /**
     * Which BUILD IMPLEMENTATION this deploy uses — not which lane string it gets.
     *
     * `RUNNER_ENABLED` was the two-week rollback in every draft of the plan, and
     * as it stood it could not be: `resolve.ts:211` is the whole of what it did —
     * `wantsRunner ? (runnerAllowed ? "runner" : (dockerfile ? "container" :
     * "buildpack"))`. So `RUNNER=0` did not mean "use the new path", it meant "use
     * the BUILDPACK lane", which the collapse deletes. Flipping it to roll back
     * would have selected a path that no longer existed.
     *
     * Re-scoped here to the question it should always have asked. `RUNNER=1` is
     * what production runs today and changes nothing; `RUNNER=0` routes every app
     * that has no Dockerfile of its own through a generated one. That makes the
     * cutover a single environment variable in both directions, and it lets this
     * code land while production is still on the old path.
     */
    const generatedBuild = !RUNNER_ENABLED;
    // Held so the file can be RE-rendered once the build's secrets are known.
    //
    // Moving this whole block to after provisioning is what Part 4 restructures
    // for, and it is not a small move: the Dockerfile's EXISTENCE is read off the
    // disk three separate times after this point — `hasDockerfile` at :1639, which
    // feeds the lane; the `isNextApp` arm below; and `useDockerBuild` at the build
    // site — so the file has to be there from here on or the lane changes under
    // the deploy. Re-rendering the same path costs one write and moves nothing.
    let renderInput: DockerfileInput | null = null;
    // A site whose build produces files and nothing to run keeps its own lane, and
    // that is Part 1's "(unchanged)". Containerising it around an entrypoint the
    // build never emits is the regression the three conditional framework rows in
    // detect.ts exist to avoid.
    const servesStatic = s.serve?.mode === "static";
    // RECORDED as a stage, which is half of what Part 4 asks for and the half
    // that is free.
    //
    // Part 4 wants this extracted into a function with explicit inputs. That is
    // worth doing and it is not this: the block reads nine closure variables that
    // are assigned above it and below it, and moving it is a hundred lines of
    // surgery on a two-thousand-line function whose behaviour is covered by eight
    // scenarios. Recording it costs one wrapper and makes the thing Part 4 wanted
    // the measurement FOR — how long rendering takes, and whether it is where
    // deploys die — answerable today from `deploy_stages`.
    //
    // Nothing else here changes: no rendering decision moves, and the file is
    // still written where every later existence check expects it.
    // The primary service's OWN Dockerfile, when the service is not the
    // repository root.
    //
    // The check below asked only about the root, so a repo whose author put the
    // build definition in `backend/` had it ignored and a generated one written
    // over the top. That is how the full-stack FastAPI template deployed with no
    // frontend in its API image: `backend/Dockerfile` builds `./frontend` and
    // copies the result in, and nothing ever ran it.
    const primaryDirForBuild = (() => {
      const cfg = appConfig ? primaryService(appConfig) : undefined;
      return cfg?.dir && cfg.dir !== "." ? cfg.dir.replace(/^\.\//, "").replace(/\/+$/, "") : "";
    })();
    const primaryOwnDockerfile = primaryDirForBuild && existsSync(join(dir, primaryDirForBuild, "Dockerfile"))
      ? `${primaryDirForBuild}/Dockerfile`
      : "";
    if (primaryOwnDockerfile) {
      log(`Building with ${primaryOwnDockerfile} — the repository's own, from the repository root`);
    }

    if (!primaryOwnDockerfile && (runtimePinned || generatedBuild) && !servesStatic && !existsSync(join(dir, "Dockerfile"))) {
      const renderStage = stages.start("render");
      const runCommand = runCmd || s.startCommand || "";
      // What the REPOSITORY says, read by code rather than by a model. `pinned`
      // answered only "python or node, at the version a file named" and only for
      // the repos the runner could not serve; this answers install, build, start,
      // apt packages and every toolchain the repo declares, for all seven
      // languages, and it resolves the version to a tag rather than passing a
      // range through to `FROM`.
      //
      // Rooted at the PRIMARY SERVICE's directory rather than at the repository,
      // because those are only the same thing for a single-app repo. When
      // inference splits a monorepo the primary can be `apps/web` — and detecting
      // the parent of that is the measurement `infer-services.ts` was written
      // around: the same detector pointed at the parent answered "Static site,
      // 80%" and was wrong about a repository it read correctly one level down.
      //
      // The build CONTEXT stays the repository root — a workspace member's
      // install needs the root lockfile — so the toolchain's `dir` is what
      // carries the offset, which is exactly what `dir` is for.
      const primaryCfg = appConfig ? primaryService(appConfig) : undefined;
      const primaryRel = primaryCfg?.dir && primaryCfg.dir !== "." ? primaryCfg.dir : ".";
      const spec = detect(
        primaryRel === "." ? dir : join(dir, primaryRel),
        { run: runCmd, config: primaryCfg, repoRoot: dir },
        primaryRel,
      );

      // The detector's and the planner's answers still win where they have one:
      // they are what deploys apps today, and this step replaces the ROUTING, not
      // their opinions. Applied to the serving toolchain rather than alongside it,
      // because `generateDockerfile` reads `toolchains` in preference to the flat
      // fields — so setting both would silently drop one of them.
      // An INFERRED config must not override the toolchain, because it is the
      // same reading arriving twice — and the second copy is lossier.
      //
      // `inferAppConfig` builds its services out of `detect()`, and a
      // `ServiceConfig` has ONE install field where a toolchain has two. So
      // `uv sync --frozen --no-dev --no-install-project` (cacheable, before the
      // source) and `uv sync --frozen --no-dev` (after it) come back joined by
      // `&&` and land entirely in the cached layer — where the project install
      // has no source to install and the build fails. A user's config and a
      // planner's plan are genuinely new information and still win; our own
      // inference is not.
      const configIsOurs = Boolean(appConfig) && !configWasWritten;
      const override = configIsOurs
        ? { install: undefined, build: undefined }
        : { install: runnerInstall ?? s.installCommand ?? undefined, build: runnerBuild ?? s.buildCommand ?? undefined };
      const toolchains = spec.toolchains.map((t, i) => (i === 0
        ? { ...t, install: override.install ?? t.install, build: override.build ?? t.build }
        : t));
      const primary = toolchains[0];
      try {
        if (!runCommand.trim() && !spec.command) {
          throw new DockerfileError("nothing to run — neither the repository nor the plan named a start command");
        }
        renderInput = {
          language: primary?.language ?? pinned?.language ?? String(s.runtime || "node"),
          version: primary?.version ?? pinned?.spec,
          install: primary ? undefined : override.install,
          build: primary ? undefined : override.build,
          // A repo declaring no manifest we know has no toolchain, and the flat
          // fields above carry it instead.
          toolchains: toolchains.length ? toolchains : undefined,
          // What this app's own build has already been repaired into needing.
          //
          // `needs` starts nearly empty and grows from real failures — but until
          // now it grew only within a single deploy, in a scratch directory that
          // dies with it. So an app rescued by adding `libpq-dev` regenerated the
          // identical Dockerfile next time and paid the whole repair loop again,
          // which reads as the fix not having worked rather than not having been
          // kept.
          needs: [...new Set([...spec.needs, ...((await readBuildHints(slug))?.needs ?? [])])],
          command: runCommand || spec.command!,
          // Resolved against the disk, so only files that exist are named. The
          // glob this replaces was a hard build failure on zero matches, which is
          // every Maven, Gradle, .NET and bare-`index.php` repository.
          // Every directory a toolchain installs in, plus the repository root —
          // a workspace member's install reads the ROOT lockfile, so naming only
          // the member's own manifests loses the cache and, for a frozen
          // lockfile install, the build.
          manifests: manifestPaths(dir, [".", ...toolchains.map((t) => t.dir)]),
          // Declared here so the `--build-arg` the build config passes has
          // somewhere to land: an arg a Dockerfile never declares is dropped, and
          // the bundler runs without it while everything reports success.
          //
          // `buildSecrets` cannot be filled in yet — the secret references do not
          // exist until Secret Manager has been written, ~370 lines below — so
          // this render is the one that satisfies every existence check, and the
          // build site re-renders it with the mounts once it knows them.
          buildArgs: Object.keys((appConfig ? primaryService(appConfig) : undefined)?.buildEnv ?? {}),
          // `--depends-on` orders container START, not port readiness: Cloud Run
          // starts the proxy first and then this container, and the proxy still
          // has to reach Cloud SQL and bind. An app that connects at import time
          // can lose that race and die on "connection refused" against a proxy
          // that was listening 200ms later — a failure indistinguishable from a
          // database that does not exist. Workers, crons and release jobs already
          // carry this prefix; the web process is the one that never did.
          waitFor: (s.database?.engine || appConfig?.resources?.database) ? proxyWait() : undefined,
        };
        // Pin the base by digest, so a rebuild of this commit is the same build.
        //
        // The tag is what the repository asked for and stays in the log; the
        // digest is what it meant at this moment. Without it every rebuild can
        // land on a different interpreter — the `:latest` defect the version
        // resolver exists to kill, one level up and with nobody's name on it.
        //
        // Only for registries we authenticate to, and never fatal: an
        // unresolvable digest leaves the tag in place, which is what shipped
        // before this line existed.
        const tagged = baseImage(renderInput);
        const digest = await resolveImageDigest(tagged);
        if (digest) {
          renderInput = { ...renderInput, image: `${tagged.split(":")[0]}@${digest}` };
          log(`Base pinned to ${tagged} @ ${digest.slice(0, 19)}… so a rebuild is the same build.`);
        }
        // Railpack plans the build instead of us emitting a Dockerfile for it.
        // Same context, same .dockerignore, same buildx step — a different file
        // handed to `-f`, which `cachedBuildConfig` points at the frontend.
        if (selectedBuilder(process.env, slug) === "railpack") {
          const declared = (appConfig ? primaryService(appConfig) : undefined)?.buildEnv ?? {};

          // The app's own railpack.json wins, exactly as its own Dockerfile
          // does: it is the author saying how to build this, and it is newer
          // information than anything we inferred. Ours is written only into the
          // silence.
          if (existsSync(join(dir, "railpack.json"))) {
            log("Using the repository's own railpack.json.");
          } else {
            writeFileSync(join(dir, "railpack.json"),
              JSON.stringify(railpackConfig({ spec, buildEnv: declared }), null, 2));
          }

          // Where this app will live, told to the build — the only moment a
          // browser bundle can still hear it.
          //
          // Learned from the app's own `.env` files rather than from `ARG`
          // declarations, because a plan has none. Computed HERE, unlike the
          // Dockerfile route which does it much later beside cloudbuild.yaml:
          // on this lane the values are baked in when the PLAN is generated, and
          // the plan is generated on the next line.
          //
          // Shallow on purpose — the repo root and one level down. A monorepo
          // keeps its frontend in `frontend/`, which is exactly where the
          // FastAPI template's `.env` sits, and an unbounded walk of a stranger's
          // repository is a cost with no matching gain.
          const envFiles: string[] = [];
          const roots = [dir, ...readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
            .map((e) => join(dir, e.name))];
          for (const root of roots) {
            for (const name of ENV_FILENAMES) {
              const p = join(root, name);
              if (existsSync(p)) { try { envFiles.push(readFileSync(p, "utf8")); } catch { /* unreadable is silent */ } }
            }
          }
          const address = publicUrlEnvArgs(envFiles, `https://${slug}.supersonic.cv`,
            Object.entries(declared).map(([key, value]) => ({ key, value: String(value) })));
          if (address.length) {
            log(`Telling the build where this app will live: ${address.map((a) => a.key).join(", ")}`);
          }

          // `--env`, not `--build-arg`: on this lane the values are baked in
          // when the PLAN is generated. An app that declared build env in
          // supersonic.json and lost it here would build without it and say
          // nothing, which is the same silent drop the lane's other two
          // fall-throughs were.
          const buildEnv = { ...declared, ...Object.fromEntries(address.map((a) => [a.key, a.value])) };
          await runOrExplain("railpack", railpackPrepareArgs(dir, { spec, buildEnv }), (l) => log(l));
          writeFileSync(join(dir, ".dockerignore"), dockerignore());
          log(`Railpack planned this build — ${spec.language}${spec.framework ? ` (${spec.framework})` : ""}.`);
        } else {
          writeFileSync(join(dir, "Dockerfile"), generateDockerfile(renderInput));
          writeFileSync(join(dir, ".dockerignore"), dockerignore());
        }
        // Says where the version came from, not just what it is. `versionFrom` is
        // ".python-version", or "pyproject.toml requires-python >=3.11,<3.13 →
        // 3.12", or "platform default" — and the last one is the case an owner
        // most needs to see, because it is the only one they did not choose.
        log(`Building an image on ${primary?.language ?? renderInput.language} ${primary?.version ?? renderInput.version ?? ""}`
          + ` — ${primary?.versionFrom ?? pinned?.from ?? "platform default"}.`);
      } catch (e) {
        // Never fatal: the app still deploys the way it would have, and the log
        // says why it is not getting an image of its own. With the runner gone
        // there is nothing left to fall back TO, which is what makes this a
        // temporary kindness rather than a permanent one — see Part 4.
        renderInput = null;
        log(`! could not generate a Dockerfile (${e instanceof Error ? e.message : String(e)})`
          + ` — deploying the way this app would have been deployed before.`);
      }
      // Outcome, not exit path: this block swallows its own failure on purpose,
      // so "did it throw" is not the question — "did an image get described" is.
      await stages.end(renderStage, renderInput ? "ok" : "failed");
    }
    // The repository's own build definition, wherever the author put it. A
    // service that is not the repo root keeps its Dockerfile beside itself, and
    // reading only the root sent such an app down the buildpack lane — which has
    // no image name at decision time, so `fleetEligibility` refused it with
    // "this deploy produced no image to place" and it went to Cloud Run. The
    // author was explicit; that is what the lane is supposed to honour.
    const primaryCfgDir = (() => {
      const cfg = appConfig ? primaryService(appConfig) : undefined;
      return cfg?.dir && cfg.dir !== "." ? cfg.dir.replace(/^\.\//, "").replace(/\/+$/, "") : "";
    })();
    // A Railpack plan counts. This flag has never meant "the author wrote a
    // Dockerfile" — the block above WRITES one and this line then finds it — it
    // means "there is a definition that builds a container here", which is the
    // question `laneFor` below is asking. A plan answers it the same way.
    //
    // Getting this wrong is not cosmetic: without it a railpack build takes the
    // buildpack lane, which has no image name at decision time, so
    // `fleetEligibility` refuses it with "this deploy produced no image to
    // place" and the app silently lands on Cloud Run — the exact failure the
    // comment above this one records for services that keep their Dockerfile in
    // a subdirectory.
    const hasDockerfile = existsSync(join(dir, "Dockerfile"))
      || existsSync(join(dir, RAILPACK_PLAN))
      || Boolean(primaryCfgDir && existsSync(join(dir, primaryCfgDir, "Dockerfile")));

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

    // ONE lane decision, in lib/resolve.ts, for the deploy and for the CLI.
    //
    // This used to be a second derivation living here — a string match on
    // `s.runtime` with its own rules — while `deriveLane` was called only by
    // `supersonic check` and by `resolveService`. So `assertConsumed` validated a
    // service against a lane the deploy might not take, and a config could
    // resolve to `runner` locally and deploy on `buildpack` in production with
    // nobody informed. The two extra facts this side knows — the RUNNER flag and
    // an agent-supplied run command — are now inputs to that function rather than
    // a reason to have a second one.
    //
    // A Dockerfile normally wins because the author was explicit; an agent's
    // `--run` overrides it, because a repo Dockerfile may not be self-contained
    // (an Nx `COPY dist/api` Dockerfile assumes a prior build). Language comes
    // from the runtime string only — never from the framework.
    const lane = staticServe ? "static" : laneFor({
      runtime: String(s.runtime || ""),
      dockerfile: hasDockerfile ? "Dockerfile" : undefined,
      runnerEnabled: RUNNER_ENABLED,
      runCommandSupplied: Boolean(runCmd),
      runtimePinned,
    });
    const runnerLang: "node" | "python" | null = lane !== "runner" ? null
      : String(s.runtime || "").startsWith("python") ? "python" : "node";

    // Now that the lane is known, the rest of the deploy is charged to it — in
    // the vocabulary the deploy actually EXECUTES. `deployArgs` is called below
    // with lane: "runner", "container" and "buildpack"; the recorder used to
    // write "runner", "generic" and "fast" for the same three paths, so
    // `deploy_stages` has been collecting data since 004 that could not answer
    // the question 004 was created to ask.
    //
    // `runtime` and `cold` are attached here for the same reason the lane is:
    // this is the first moment all three are known. `cold` is a first deploy —
    // no live Cloud Run service — which is a guaranteed cache miss and also the
    // moment the product is judged, so it is the number that decides whether a
    // 2-4 minute cold build is affordable.
    const laneNow = lane;
    stages = new StageRecorder(slug, laneNow, undefined, undefined, undefined, {
      runId: input.runId,
      runtime: String(s.runtime || "") || null,
      // Null for the static lane on purpose: it publishes to GCS and has no
      // Cloud Run service of its own, so "no service exists" is not evidence of a
      // first deploy there. A wrong value in a column that exists to settle an
      // argument is worse than an absent one.
      cold: staticServe ? null : await isFirstDeploy(slug),
    });

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

    // What this app RUNS, read once, before anything is built.
    //
    // `serviceless` is the answer to a question the pipeline has never had to ask:
    // does this app have a `web` process at all? A Telegram bot does not. It has
    // no HTTP, no port, no URL, no domain mapping and nothing to probe — and
    // deploying a Cloud Run service for it anyway would put the bot right back to
    // pretending to be a web server, which is the defect this whole plan removes.
    //
    // An app that declares NO processes is not serviceless: its `start` command IS
    // its web process under an older spelling, and it takes exactly the path it
    // took yesterday. See `isServiceless`.
    const processes = readProcesses(dir, primaryConfigService, log);
    const serviceless = !staticServe && isServiceless(processes);
    if (serviceless) {
      log(`No web process — deploying ${processes.length === 1 ? "one process" : `${processes.length} processes`} and no service`);
    }

    // A release declared in config rather than a Procfile has always been run by
    // lib/release-job.ts as a Cloud Run Job. On the fleet a release is an
    // ordinary process, so it has to arrive as one. Appended after `serviceless`
    // is decided: a release process has no `web` kind, and folding it in earlier
    // would make an app with only a config release — and no Procfile at all —
    // read as having declared processes with none of them a web server, which is
    // the "no web process, no service" branch for an app that never asked for one.
    //
    // `releaseCmd` rather than a fresh `releaseCommand(primaryConfigService)`
    // read, deliberately: it is the exact value the Cloud Run branch already
    // hands to `runRelease` a few hundred lines down, already `inDir`-wrapped for
    // a monorepo service, and already resolved with config outranking a
    // Procfile-inferred command (see `detect.test.ts`, "the config outranks
    // every inferred migration command"). Re-deriving it here from config alone
    // would silently drop both of those and let the two runtimes disagree about
    // which command a release even is — the exact bug this task exists to close.
    // A release the REPOSITORY declares somewhere the pipeline did not read.
    //
    // Config, Procfile and the planner's `preRun` were the three places asked,
    // and a repository has more. The full-stack FastAPI template declares its
    // migrations in compose — a service the app waits to FINISH — and deployed
    // here with an empty schema: every form answered `relation "user" does not
    // exist` while the deploy was reported live.
    //
    // Last, so anything already resolved wins: this is for the case where
    // nothing else spoke, which is also the case where `inferAppConfig` produced
    // the plan and therefore the planner never ran at all.
    if (!releaseCmd.trim()) {
      const declared = detectRelease(Object.fromEntries(
        RELEASE_FILES.map((f) => [f, existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : undefined]),
      ));
      if (declared) {
        releaseCmd = declared.command;
        // Said out loud BEFORE it runs. A failed release stops the app coming up
        // at all, so a person has to be able to see what we decided on their
        // behalf without reading a dead deploy to find out.
        log(`Running migrations first: ${declared.command} — declared in ${declared.from}`);
      }
    }
    if (releaseCmd.trim() && !processes.some((p) => p.name === "release")) {
      processes.push(resolveProcess("release", { command: releaseCmd }));
    }

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
    /** Enough of the provisioned role to name the same database at another address. */
    let pgFacts: { user: string; password: string; dbName: string } | null = null;
    // The app's own Postgres role, when it got one.
    let dbIsolated = false;
    let dbPassword = "";

    // Provisioning does not depend on the build, so it is started here and
    // awaited only where its results are actually needed — the database and
    // the bucket get created while Cloud Build is already working. Both
    // settle rather than reject: a missing bucket has always been survivable,
    // and starting them early must not change that.
    // Whose database this is decides whether anything is provisioned at all.
    //
    // An app that already has one — Supabase, Neon, an RDS instance — gets its
    // connection from its own secret and nothing else happens: no Cloud SQL
    // database, no per-app role, and no proxy container beside it. That last
    // omission is the reason this mode is simpler rather than more complex, since
    // the sidecar is what drags in the container-scoped argv, the mandatory
    // startup probe and the one-container-must-declare-a-port rule.
    const externalDb = appConfig?.resources?.database?.provider === "external"
      ? appConfig.resources.database
      : null;
    // WHAT THIS APP GETS, decided once, from what it asked for.
    //
    // `provisionStorage` used to be called right here with no condition at all,
    // while `resources.bucket` and `uses: ["bucket"]` were both parsed and read by
    // nothing — so every app was billed for a bucket, carried STORAGE_BUCKET it
    // never asked for, and was told in the dashboard that it had "File uploads".
    // That was not an oversight in one branch; it was that no place existed where
    // "what does this app need" is a single value. lib/resources.ts is that place.
    const declaredNeeds: Declared = {
      database: Boolean(s.database?.engine) || Boolean(appConfig?.resources?.database),
      externalDatabase: Boolean(externalDb),
      bucket: Boolean(appConfig?.resources?.bucket)
        || Boolean(appConfig?.services.some((svc) => (svc.uses ?? []).includes("bucket"))),
      processes: processes.some((pr) => pr.kind === "worker" || pr.kind === "cron"),
      web: !staticServe && !serviceless,
      secrets: Object.keys(secrets),
    };
    const bucketNow = await bucketState(slug);
    const resourcePlan = planResources(declaredNeeds, {
      bucketExists: bucketNow.exists,
      bucketInUse: bucketNow.inUse,
      databaseExists: await databaseExists(slug),
    });
    const wants = (kind: string) => resourcePlan.attach.some((r) => r.kind === kind);
    // Said out loud, and only for the ones with something to say. A resource the
    // app is losing is the line somebody needs when a variable stops appearing.
    for (const r of resourcePlan.release) {
      if (r.kind === "bucket" && bucketNow.exists) log(`Object storage: ${r.reason}`);
      if (r.kind === "database" && r.reason.includes("kept")) log(`Database: ${r.reason}`);
    }

    // With a Dockerfile, build it ourselves with a registry layer cache and
    // deploy the image — so an unchanged `npm install` is reused and redeploys
    // are dramatically faster. Which builder does it is BUILDER's call
    // (buildkit vs the Kaniko default); see lib/build-config.ts. Without a
    // Dockerfile, fall back to buildpacks.
    const IMAGE = `${REGION}-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy/${slug}`;
    // What a worker or a cron runs. The SAME artifact the web process got — a
    // worker built separately could differ from the service beside it, which is
    // the one thing a process model must not allow.
    //
    // The buildpack lane has no image at this point: `run deploy --source` builds
    // one and only Cloud Run knows its name. Building again with `--source` per
    // worker would pay for the same build a third time (the release job already
    // pays for it twice, and says so), so the deployed image is read back from
    // the live service instead — one API call against N builds.
    const processImage = lane === "runner"
      ? (runnerLang === "python" ? RUNNER_PYTHON_IMAGE : RUNNER_NODE_IMAGE)
      // A serviceless buildpack app built its image with `builds submit --pack`
      // under the same name, so there is no service to read it back from and no
      // need to.
      : lane === "container" || serviceless ? `${IMAGE}:latest` : undefined;

    // Which runtime this deploy takes, decided here — before anything is
    // deployed — because `provisionPostgres` right below needs the answer to
    // hand the app an address it can actually reach. `chooseRuntime` says what
    // the fleet CAN serve; `fleetPlacementWanted` says what it is ALLOWED to
    // serve yet. Task 10 drops the second half once one app has proved the
    // path; until then the first app to prove it is whichever one somebody
    // happens to deploy.
    //
    // Read fresh rather than reusing `hasDockerfile` above: that read happened
    // before the SPA and Next.js fallback Dockerfiles (just above this block)
    // were written, so an app can have gained one since. The lane label was
    // fixed even earlier and does not update either way — this is the checkout
    // telling the truth about how the app will actually be built.
    const hasDockerfileNow = existsSync(join(dir, "Dockerfile")) || Boolean(primaryOwnDockerfile);
    // `workers` is what makes "worker-only" placeable and "cron-only" not. The
    // node confirms a process it is RUNNING, and a cron is never running — the
    // agent's reconcile excludes it, because the scheduler owns it — so an app
    // whose only declared process is scheduled has nothing a node could report
    // and every deploy of it would roll back.
    const workerCount = processes.filter((pr) => pr.kind === "worker").length;
    // A dependency we will not run, refused before anything is built.
    //
    // Stated with the reason rather than ignored: an app that declares
    // elasticsearch and gets a deploy with no elasticsearch in it fails later,
    // somewhere inside a client library, and looks like the app's bug.
    for (const declared of (appConfig ? [...new Set(appConfig.services.flatMap((v) => v.uses ?? []))] : [])) {
      const refusal = dependencyRefusal(declared);
      if (refusal) throw new Error(`${CONFIG_FILENAME} asks for ${declared}, and ${refusal}.`);
    }

    const target = chooseRuntime({ lane, image: processImage ?? "", staticServe: !!staticServe, serviceless, hasDockerfile: hasDockerfileNow, workers: workerCount });
    const toFleet = target.runtime === "fleet" && fleetPlacementWanted(process.env, slug);
    // Which target THIS deploy actually lands on — not `target` above, which is
    // only what the fleet is capable of before `fleetPlacementWanted` gates it.
    // Asked once, here, so the rest of this function answers a capability
    // question (`deployTarget.supports(...)`) instead of re-deriving `toFleet`'s
    // meaning at each call site — see lib/deploy-target.ts for why that
    // re-derivation is exactly how the domain-mapping bug below survived.
    const deployTarget = deployTargetFor(toFleet ? "fleet" : "cloudrun");
    // The address the database is provisioned at is `deployTarget`'s, and
    // that follows `toFleet`, never `target.runtime` alone — the two differ
    // for exactly the apps this gate exists for: an app the fleet could serve
    // but is not yet a canary still deploys to Cloud Run, and handing it
    // FLEET_DB would give that Cloud Run revision an address it cannot reach
    // — the same failure this whole task exists to stop, arriving through the
    // back door. `deployTarget` is already built from the same `toFleet` one
    // line up, so asking it directly here is one fewer place carrying that
    // condition rather than a second copy of it re-derived by hand.

    const pgPromise = wants("database") && s.database?.engine === "postgres"
      ? provisionPostgres(slug, log, deployTarget.databaseAddress).then(
          (pg) => ({ ok: true as const, pg }),
          (e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
        )
      : null;
    if (externalDb) {
      // Said out loud, because "no database was provisioned" and "the database is
      // yours" look identical in a log otherwise, and the first is a failure.
      log(`Using your own ${externalDb.engine ?? "database"} — reading its URL from ${externalDb.urlFrom}, provisioning nothing`);
      // Before the build, not at container start.
      //
      // `missingSecrets` has existed since schema v2 and was called from exactly
      // one place: `supersonic check`, on the user's machine. So the rule the
      // schema calls ENFORCED was enforced only by the tool a deploy does not have
      // to run through. For a managed database that was survivable, because the
      // platform supplied the connection either way; for one the app owns, the
      // missing value IS the deploy, and the first thing to notice it would have
      // been the app's own driver, nine minutes later, inside a crash loop.
      //
      // THREE places a value can already be, and the check has to ask all of
      // them. Asking fewer is the mistake assertReached made once already, and
      // the first version of this check made it again: it asked this deploy's
      // upload and Secret Manager, while `supersonic env set` writes neither —
      // `setEnv` in lib/gcloud.ts is `gcloud run services update
      // --update-env-vars`, a plain variable on the live service. So the one
      // documented way to supply a value out of band was the one way this could
      // not see, and it would have refused the deploy of an app whose
      // DATABASE_URL was set and working.
      const supplied =
        Boolean(secrets[externalDb.urlFrom])
        || Boolean(await readAppSecret(slug, externalDb.urlFrom).catch(() => null))
        || (await liveEnvNames(slug)).includes(externalDb.urlFrom);
      if (!supplied) {
        throw new Error(
          `${CONFIG_FILENAME} declares an external database whose URL comes from ${externalDb.urlFrom}, ` +
          `and nothing has set a value for it.\n` +
          `  Put ${externalDb.urlFrom} in your .env, or run \`supersonic env ${friendlyName} set ${externalDb.urlFrom}=…\`, then deploy again.\n` +
          `  Nothing was provisioned and nothing was built — this stopped before either.`,
        );
      }
    }
    const storagePromise = wants("bucket")
      ? provisionStorage(slug, log).then(
          (bucket) => ({ ok: true as const, bucket }),
          (e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
        )
      : null;
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
          dbEnv = databaseEnv(r.pg, deployTarget.databaseAddress);
          // Kept whole, because a SIBLING needs the same database at a different
          // address — see `siblingDbEnv` below. Only the four fields that name
          // the connection; nothing here is the primary's placement.
          pgFacts = { user: r.pg.user, password: r.pg.password, dbName: r.pg.dbName };
          dbIsolated = r.pg.isolated;
          dbPassword = r.pg.password;
          log("Provisioned the database — connecting through a Cloud SQL proxy");
        } else {
          log(`! ${r.error} — deploying without a database`);
        }
      }
      // Only when the app asked, or when it already has objects in one — see
      // `bucketState` for why an in-use bucket is kept for an app that never
      // declared it. GOOGLE_CLOUD_PROJECT rides with it because it is only
      // meaningful for reaching the bucket.
      if (storagePromise) {
        log("Provisioning object storage…");
        const st = await storagePromise;
        if (st.ok) {
          extraEnv.push(`STORAGE_BUCKET=${st.bucket}`);
          extraEnv.push(`GOOGLE_CLOUD_PROJECT=${PROJECT}`);
        } else {
          log(`! storage skipped: ${st.error}`);
        }
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
      // The WEB process's command IS the run command.
      //
      // `processes` was wired into the schema, the resolver, the planner and
      // `supersonic check`, and the SERVICE deploy went on reading only `start`.
      // So an app declaring `processes: { web: { command: … } }` and no `start`
      // — which is the whole point of declaring processes — reached the runner
      // with no SUPERSONIC_RUN and died on
      //
      //   FATAL: no run command for this app
      //
      // while every worker beside it started correctly, because the process path
      // had been wired and the service path had not. Found by deploying a CRM;
      // 695 tests had nothing to say about it.
      const webCommand = (processes.find((pr) => pr.kind === "web") as { command?: string } | undefined)?.command;
      if (!runCmd && webCommand) runCmd = webCommand;
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
    // The resource envelope. Authored in schema v2, defaulted when it is not —
    // `withScale` merges a partial over DEFAULT_SCALE, so declaring `cpu` alone
    // does not silently drop the memory floor that four lanes depend on.
    //
    // This was `= DEFAULT_SCALE` until the deploy that declared `scale` and got
    // the defaults anyway: parsed, validated, listed by `supersonic check`, named
    // in LANE_CONSUMES, and thrown away by one assignment. The plan called it the
    // last schema v2 field a deploy accepts and does not act on, and deferred it
    // to Phase 3's executor; it turned out to be this line. assertReached is what
    // stopped the deploy rather than shipping a fifth instance of the same bug.
    const scale: Scale = withScale(primaryConfigService?.scale);
    // What "it works" means for THIS app. `strict` records whether the author
    // said so or the platform defaulted it: a declared `expect: 200` that comes
    // back 302 is a broken deploy and the field exists to say so, while an
    // undeclared default cannot be that strict — plenty of correct apps redirect
    // their root to /login.
    // The WEB process's own health check outranks the service-level one.
    //
    // `processes.web.health` was added to the schema, parsed, validated and
    // printed back by `supersonic check` — and the probe went on reading the
    // service-level field, so a CRM declaring `/health` was probed at `/`. A
    // field accepted and not applied is the single defect this whole effort is
    // about, and adding a new instance of it while removing the old ones is
    // exactly how the old ones got there.
    //
    // Service-level `health` still works and still wins when a service declares
    // it and its web process does not, so nothing already deployed changes.
    const webProcess = processes.find((pr) => pr.kind === "web") as { health?: HealthConfig } | undefined;
    const declaredHealth = webProcess?.health ?? primaryConfigService?.health;
    const primaryHealth = {
      health: declaredHealth ?? { path: "/", expect: 200 },
      strict: Boolean(declaredHealth),
      spaFallback: primaryConfigService?.spaFallback,
    };

    const useDockerBuild = hasDockerfileNow;
    // Slug-aware, so `BUILDKIT_APPS=<slug>` can prove the registry auth on one
    // app before the default moves. Without the slug this reads the global
    // `BUILDER` exactly as it did.
    const builder = selectedBuilder(process.env, slug);
    if (useDockerBuild) {
      // Build-time secrets, on the lane that never had them.
      //
      // `runnerPrepareConfig` is the only build config in the repo that has ever
      // mounted one, and it is being deleted. The reason it cannot simply go is
      // written at its own definition: Prisma 7 evaluates `env('DATABASE_URL')`
      // while loading prisma.config.js on EVERY cli command, so `prisma generate`
      // died on an app whose database the platform had just provisioned.
      //
      // Not offered under kaniko, and not silently: kaniko has no
      // `--mount=type=secret`, so its only channel is `--build-arg`, whose values
      // are readable in the history of an image that is pushed to a SHARED
      // repository and deleted by nothing. `cachedBuildConfig` would switch this
      // build to buildkit to make it work, and doing that on its own initiative
      // would move every container app onto a builder whose registry `--push`
      // auth docs/CUTOVER.md records as unverified — "total failure of the lane,
      // not a degraded cache". So this waits for BUILDER=buildkit rather than
      // deciding for the operator, and says so when it is skipping something.
      const wanted = buildSecrets(secretRefs);
      const mountable = mountsBuildSecrets(builder) ? wanted : [];
      if (wanted.length && !mountable.length) {
        log(`! ${wanted.map((r) => r.key).join(", ")} will not be readable during the build — `
          + `the current builder cannot mount a secret without baking it into the image. Set BUILDER=buildkit.`);
      }
      if (mountable.length) {
        // Was called from inside the runner branch only, which is why the
        // container lane could not read a secret even where the builder could.
        await grantBuildAccess(mountable, BUILD_SA, log);
        log(`Build may read ${mountable.map((r) => r.key).join(", ")}`);

        // The second half of the render, and the only place it can happen: the
        // generated Dockerfile has to declare `RUN --mount=type=secret` for each
        // of these, and until this line nothing knew their names. Rendering the
        // same path again is deliberate — the file's EXISTENCE was already read
        // off the disk to decide the lane, so it must not disappear and reappear;
        // only its contents change.
        //
        // A repo's OWN Dockerfile is left alone. It is the author's file, the
        // build config already offers the secrets to it, and rewriting somebody's
        // committed Dockerfile is what this whole path exists not to do.
        if (renderInput) {
          try {
            writeFileSync(join(dir, "Dockerfile"), generateDockerfile({
              ...renderInput,
              buildSecrets: mountable.map((r) => r.key),
            }));
          } catch (e) {
            // Never fatal, for the same reason the first render is not: the app
            // still builds on the Dockerfile already written, without the mounts.
            log(`! could not offer ${mountable.map((r) => r.key).join(", ")} to the build `
              + `(${e instanceof Error ? e.message : String(e)}) — building without them`);
          }
        }
      }
      // `buildEnv` — accepted by the schema, validated, listed in the lane's
      // consumes-list, printed back by `supersonic check` and asked about by
      // `supersonic init`, and until now read by NO build path. That is the
      // declared-but-not-reflected defect this codebase is named after, in its
      // sixth documented instance. A `NEXT_PUBLIC_*` set here and not passed to
      // the build is worse than one that was rejected: the bundler bakes the
      // wrong value into the shipped JavaScript and everything reports success.
      //
      // An arg and not a secret, deliberately. Its values are readable in image
      // history forever, which is correct for the public build-time constants it
      // is for and is why anything sensitive belongs in `secrets`.
      const buildArgs = Object.entries(primaryConfigService?.buildEnv ?? {}).map(([key, value]) => ({ key, value }));
      // Where this app will live, told to the build — the only moment a browser
      // bundle can still hear it. Vite, Next and CRA write their env into the
      // JavaScript they ship, so the API URL at BUILD time is what the user's
      // browser calls forever.
      //
      // Only names the Dockerfile itself declares, and only ones that mean an
      // address. The FastAPI template declares `ARG VITE_API_URL=` for exactly
      // this and nobody passed it: its backend answered 200 on the node while
      // the signup form posted to http://localhost:8000 and showed "Something
      // went wrong".
      const ownDockerfilePath = primaryOwnDockerfile
        ? join(dir, primaryOwnDockerfile)
        : join(dir, "Dockerfile");
      if (existsSync(ownDockerfilePath)) {
        const told = publicUrlBuildArgs(readFileSync(ownDockerfilePath, "utf8"), `https://${slug}.supersonic.cv`, buildArgs);
        if (told.length) {
          log(`Telling the build where this app will live: ${told.map((a) => a.key).join(", ")}`);
          buildArgs.push(...told);
        }
      }
      // The railpack lane has no `else` here on purpose: it answers this question
      // in the render stage, where its plan is generated, because that is when
      // the value has to already be in hand. See `publicUrlEnvArgs` there.
      if (buildArgs.length) log(`Build args: ${buildArgs.map((a) => a.key).join(", ")}`);
      // Context stays the repository root — which is what an author who put the
      // Dockerfile one level down and wrote `COPY ./frontend` is expecting.
      writeFileSync(join(dir, "cloudbuild.yaml"), cachedBuildConfig(IMAGE, builder, slug, {
        secretEnv: mountable, buildArgs,
        ...(primaryOwnDockerfile ? { dockerfile: primaryOwnDockerfile } : {}),
      }));
    }
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
    /**
     * The app's own last words, attached to whatever the tooling concluded.
     *
     * `diagnose()` reads gcloud's output and guesses. On the FastAPI template it
     * guessed "didn't start on $PORT — most likely needs environment/secrets
     * that aren't set yet (e.g. DATABASE_URL)", and the truth was
     * `RuntimeError: Frontend directory '/app/app/frontend' does not exist`,
     * sitting in the revision's own log the whole time.
     *
     * The same fix `placeOnFleet` already carries, on the other runtime: ask the
     * app rather than the platform. Swallowed whole on failure — a log we cannot
     * read is not a reason to lose the error we already have.
     */
    const withAppLog = async (service: string, error: string): Promise<string> => {
      try {
        const lines = (await getLogs(service, { limit: 20, freshness: "10m" })).map((l) => l.message);
        if (!lines.length) return error;
        log(`· what ${service} said before it stopped:`);
        for (const l of lines) log(`    ${l}`);
        return `${error}\n\nWhat ${service} said before it stopped:\n${lines.map((l) => `  ${l}`).join("\n")}`;
      } catch {
        return error;
      }
    };

    const attempt = async (args: string[]): Promise<{ ok: boolean; url?: string; error?: string }> => {
      // A worker-only app builds exactly as any other app and then deploys no
      // service. Skipping HERE rather than branching per lane is deliberate: every
      // lane reaches its `gcloud run deploy` through this one function, so one
      // guard covers all of them and no lane can be added that forgets it. The
      // prepare/build/release steps above are untouched — they are what produces
      // the artifact the workers run.
      if (serviceless) return { ok: true };
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
          if (SEAL_APPS && wants("invoker")) await grantInvokers(slug, log);
          log("verifying the app responds…");
          const probe = await probeApp(liveUrl, log, SEAL_APPS, primaryHealth);
          if (!probe.ok) return { ok: false, error: await withAppLog(slug, probe.reason ?? "the app did not answer") };
        }
        return { ok: true, url: liveUrl };
      } catch (e) {
        clearInterval(hb);
        let err = e instanceof Error ? e.message : String(e);
        if (/build failed/i.test(err)) {
          log("fetching the real build log for the agent…");
          const buildLog = await builds.error();
          if (buildLog) err = `Cloud Build failed. Actual build output:\n${buildLog}`;
        } else {
          // Only when the BUILD was not the problem. A build that never produced
          // an image left no container to have said anything, and asking would
          // attach the previous revision's log to a failure it had no part in.
          err = await withAppLog(slug, err);
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
              await run("gcloud", ["builds", "submit", dir, "--region", REGION, "--project", PROJECT, "--config", join(dir, "cloudbuild.yaml"), ...buildIdentityArgs()], buildLine);
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
        return { ok: false, error: failureSentence("Build failed", reason) };
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
    /**
     * A sibling service: built always, then either deployed to Cloud Run or
     * handed back as a PROCESS for the node.
     *
     * `placeOnNode` is the whole difference. On Cloud Run a sibling is a second
     * service with its own URL, and the edge proxy splits traffic between them
     * by path. On a node both programs live on the same machine behind one
     * address, so the split happens in the node's router — and the sibling stops
     * needing a second database address, a second set of secrets, and an IAM
     * binding to let the platform probe it.
     */
    const deploySibling = async (
      svc: ServiceConfig,
      placeOnNode = false,
    ): Promise<{ ok: boolean; url?: string; error?: string; name: string; process?: AgentProcess }> => {
      const label = (svc.name || servicePath(svc).replace(/[^a-z0-9]+/gi, "") || "svc").toLowerCase();
      const name = cloudRunName(`${slug}-${label}`);
      /**
       * Planned as though this service were at the root, because in its own build
       * context it is.
       *
       * `planFromConfig` wraps every command with `inDir(cmd, svc.dir)` — right
       * when the context is the repository, which is what it was until a sibling
       * started building from its own directory. Now `contextDir` IS `svc.dir`,
       * so the wrap points at `api/api`: the install ran as
       * `(cd api && pip install …)` inside a context that has no `api/`, and the
       * CMD came out `(cd api && uvicorn …)` in an image whose WORKDIR already
       * holds the app. One of the two has to account for the directory, and the
       * context is the one that already does.
       */
      const plan = planFromConfig({ services: [svc] }, { ...svc, dir: "." }, planSource);
      const lang: "node" | "python" | null =
        plan.language === "node" ? "node" : plan.language === "python" ? "python" : null;
      // The refusal that made siblings node-or-python. It was never a statement
      // about siblings — it was a statement about the RUNNER, which has two images
      // because someone built two Dockerfiles. A generated image has no such
      // limit, so a sibling can be Go, and this line only applies while the runner
      // is the thing building it.
      if (!generatedBuild && !lang) {
        return { ok: false, name, error: `service "${label}" is ${plan.language}; a second service must be node or python` };
      }
      if (!plan.run) return { ok: false, name, error: `service "${label}" has no start command` };

      const siblingLane: Lane = generatedBuild ? "container" : "runner";
      /**
       * A sibling builds from its OWN directory, into its OWN image.
       *
       * Five things were shared or hardcoded, and each one is a collision rather
       * than an inconvenience: one `${IMAGE}` for the whole app, `--dockerfile=
       * Dockerfile` fixed in the build config, `${image}-cache` derived from that
       * one image so two siblings would overwrite each other's layer cache, a
       * build context rooted at the repository root, and `join(dir,
       * "cloudbuild.yaml")` — the same path the primary writes.
       *
       * Rooting the context at the service's own directory settles four of them at
       * once: `Dockerfile` and `cloudbuild.yaml` are unambiguous inside it, and the
       * image name carries the service name, so the cache repo does too.
       */
      const contextDir = join(dir, svc.dir && svc.dir !== "." ? svc.dir : ".");
      const image = generatedBuild
        ? `${REGION}-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy/${name}`
        : (lang === "python" ? RUNNER_PYTHON_IMAGE : RUNNER_NODE_IMAGE);
      const release = `${label}-${releaseId()}`;
      const key = randomBytes(32).toString("hex");
      // A sibling gets its own release job, for the same reason and by the same
      // route as the primary — its own image, its own bundle, its own command.
      const startCmd = plan.run;
      const siblingRelease = plan.preRun?.filter(Boolean).join(" && ") ?? "";

      try {
        await stages.around(generatedBuild ? "build" : "prepare", async () => {
          const mountable = mountsBuildSecrets(builder) ? buildSecrets(secretRefs) : [];
          // Where the build runs from, and what it reads as its Dockerfile. Both
          // are the service's own directory unless the author's file says
          // otherwise, and the config is named per service so two of them cannot
          // land on one path when the context is shared.
          let buildContext = contextDir;
          let dockerfileIn: string | undefined;
          const configName = `cloudbuild-${name}.yaml`;
          if (generatedBuild && existsSync(join(contextDir, "Dockerfile"))) {
            // The author's own build definition, which used to be OVERWRITTEN
            // here — the primary asked whether a Dockerfile existed before
            // generating one and this path never did, so a sibling's Dockerfile
            // was silently replaced on every deploy.
            //
            // And it is built where it expects. `backend/Dockerfile` in the
            // full-stack FastAPI template copies `./frontend`, builds it, and
            // puts the result inside the API image; its own compose file says
            // `context: .` with `dockerfile: backend/Dockerfile`. Built from
            // `backend/`, that copy finds nothing, the build still passes, and
            // the app dies on import with `Frontend directory ... does not
            // exist` — which the deploy then reported as a $PORT problem.
            const own = readFileSync(join(contextDir, "Dockerfile"), "utf8");
            const rel = svc.dir && svc.dir !== "." ? svc.dir.replace(/^\.\//, "").replace(/\/+$/, "") : ".";
            if (rel !== "." && wantsRepoRootContext(own, readdirSync(contextDir), readdirSync(dir))) {
              buildContext = dir;
              dockerfileIn = `${rel}/Dockerfile`;
              log(`Building ${label} with its own Dockerfile, from the repository root — it reads paths outside ${rel}/`);
            } else {
              log(`Building ${label} with its own Dockerfile`);
            }
            // No .dockerignore written: theirs, or its absence, is theirs too.
            const siblingArgs = Object.entries(svc.buildEnv ?? {}).map(([key, value]) => ({ key, value }));
            // Same for a sibling, at the address the app is served on — a
            // sibling is mounted under a path on the SAME origin, so the app's
            // own URL is what its frontend should call.
            siblingArgs.push(...publicUrlBuildArgs(own, `https://${slug}.supersonic.cv`, siblingArgs));
            writeFileSync(join(buildContext, configName), cachedBuildConfig(image, builder, name, {
              secretEnv: mountable,
              buildArgs: siblingArgs,
              dockerfile: dockerfileIn,
            }));
          } else if (generatedBuild) {
            log(`Building ${label} from ${svc.dir ?? "."}…`);
            // Its own detection, rooted at its own directory — which is the
            // difference `inferAppConfig` was written for: the same detector
            // pointed at `frontend/` and `backend/` returns 95% and 90%, and
            // pointed at their parent returns "Static site, 80%" and is wrong.
            // `rel` is where the toolchain sits IN THE BUILD CONTEXT, and this
            // context is the service's own directory — so it is ".", not
            // `svc.dir`. Passing `svc.dir` made every command in the generated
            // file `(cd backend && …)` inside a context that IS backend, so the
            // first RUN failed on a path that cannot exist. It broke every
            // sibling, since a sibling by definition has a directory of its own.
            //
            // `repoRoot` still points at the repository, because version files
            // are inherited downward: a monorepo writes `.nvmrc` once, at the top.
            const spec = detect(contextDir, { run: plan.run, config: svc, repoRoot: dir }, ".");
            const primary = spec.toolchains[0];
            writeFileSync(join(contextDir, "Dockerfile"), generateDockerfile({
              language: primary?.language ?? plan.language ?? "node",
              version: primary?.version,
              install: primary ? undefined : plan.install,
              build: primary ? undefined : plan.build,
              toolchains: spec.toolchains.length ? spec.toolchains : undefined,
              needs: spec.needs,
              command: plan.run!,
              // Relative to THIS context, so a sibling's manifests are named the
              // way its own build will look for them.
              manifests: manifestPaths(contextDir),
              buildSecrets: mountable.map((r) => r.key),
              buildArgs: Object.keys(svc.buildEnv ?? {}),
              waitFor: (s.database?.engine || appConfig?.resources?.database) ? proxyWait() : undefined,
            }));
            writeFileSync(join(contextDir, ".dockerignore"), dockerignore());
            writeFileSync(join(buildContext, configName), cachedBuildConfig(image, builder, name, {
              secretEnv: mountable,
              buildArgs: Object.entries(svc.buildEnv ?? {}).map(([key, value]) => ({ key, value })),
            }));
          } else {
            log(`Preparing ${label} on the ${lang} runner…`);
            writeFileSync(join(buildContext, configName), runnerPrepareConfig({
              image, bucket: ASSETS_BUCKET, slug, release, codeKey: key,
              build: plan.build, install: plan.install, language: lang!, secretEnv: buildSecrets(secretRefs),
            }));
          }
          if (mountable.length || (!generatedBuild && secretRefs.length)) {
            await grantBuildAccess(generatedBuild ? mountable : secretRefs, BUILD_SA, log);
          }
          const hb = setInterval(() => log(`${generatedBuild ? "building" : "preparing"} ${label}…`), 8000);
          builds.reset();
          try {
            await run("gcloud", ["builds", "submit", buildContext, "--region", REGION, "--project", PROJECT, "--config", join(buildContext, configName), ...buildIdentityArgs()], buildLine);
          } finally { clearInterval(hb); }
        });
      } catch (e) {
        const buildLog = await builds.error();
        const what = generatedBuild ? "Building" : "Preparing";
        return { ok: false, name, error: `${what} ${label} failed:\n${buildLog || (e instanceof Error ? e.message : String(e))}` };
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
        // The bundle plumbing is the runner's, and only the runner's. A generated
        // image already contains the code and already has the command as its CMD,
        // so pointing it at a tarball would name an object that was never written
        // — and `SUPERSONIC_RUN` would be a start command the image does not read.
        ...(generatedBuild ? [] : [
          `SUPERSONIC_CODE_BUCKET=${ASSETS_BUCKET}`,
          `SUPERSONIC_CODE_OBJECT=ready/${slug}/${release}.tgz`,
          `SUPERSONIC_RUN=${startCmd}`,
        ]),
      ];
      // A sibling deploys to CLOUD RUN even when the primary went to a node —
      // `deploySibling` has no fleet branch — and the database env it inherits
      // from the primary was computed at the PRIMARY's address. On the fleet
      // that is 10.200.0.1, the host-side proxy on the node, which nothing in
      // Cloud Run can route to. So a "frontend + API" repo placed on the fleet
      // shipped its API a database address it could never open.
      //
      // This is the failure the runtime gate two hundred lines up exists to
      // stop — "handing it FLEET_DB would give that Cloud Run revision an
      // address it cannot reach" — arriving through the one door that gate does
      // not cover. Same database, same role, stated at the address THIS service
      // actually runs at.
      let siblingDbRefs: SecretRef[] = [];
      // Only when this sibling is going to Cloud Run while its primary is on a
      // node. Placed on the SAME node it reaches the database at the same
      // address the primary does, and restating it would be the bug in reverse.
      if (toFleet && pgFacts && !placeOnNode) {
        const merged = restateDatabaseAt(
          env,
          databaseEnv(
            { databaseUrl: databaseUrlFor(pgFacts, pgFacts.dbName, CLOUD_RUN_DB), ...pgFacts },
            CLOUD_RUN_DB,
          ),
          databaseEnvNames(),
        );
        env.length = 0;
        env.push(...merged.inherited, ...merged.plainEnv);
        const stored = await putAppSecrets(name, merged.secretEnv, APP_RUNTIME_SA, log);
        siblingDbRefs = stored.stored;
        // Same fallback the primary takes: a value Secret Manager refused rides
        // as a plain variable rather than not arriving at all.
        for (const key of stored.skipped) {
          if (merged.secretEnv[key] !== undefined) env.push(`${key}=${merged.secretEnv[key]}`);
        }
        log(`${servicePath(svc)} reaches the database on ${CLOUD_RUN_DB.host} — it runs on Cloud Run, not on the node`);
      }
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
      // Minted only when there is a bundle to encrypt. With a generated image the
      // code is inside the image, so a per-bundle key protects nothing and would
      // be one more secret to store, grant and eventually leak. What replaces it
      // is registry scoping — which does not exist yet, and is Part 9's row 6.
      const siblingKeySecret = generatedBuild
        ? { stored: [] as SecretRef[], skipped: [] as string[] }
        : await putAppSecrets(name, { SUPERSONIC_CODE_KEY: key }, APP_RUNTIME_SA, log);
      // The primary's DATABASE_URL and password refs are dropped when this
      // sibling minted its own above — they point at secrets holding the node's
      // address, and two refs for one name is a revision gcloud refuses outright.
      const rewritten = new Set(siblingDbRefs.map((r) => r.key));
      const siblingRefs = [
        ...secretRefs.filter((r) => r.key !== "SUPERSONIC_CODE_KEY" && !rewritten.has(r.key)),
        ...siblingDbRefs,
        ...siblingKeySecret.stored,
      ];
      // Anything Secret Manager refused falls back to a literal, which is the
      // old behaviour and no worse — but it is said out loud rather than assumed.
      if (siblingKeySecret.skipped.length) env.push(`SUPERSONIC_CODE_KEY=${key}`);

      const siblingApp: string[] = [];
      if (siblingRefs.length) siblingApp.push(`--update-secrets=${setSecretsFlag(siblingRefs)}`);
      siblingApp.push(`--update-env-vars=^~~^${env.join("~~")}`);

      // On a node, the sibling stops here and becomes a process in the app's
      // placement. Everything above — its own image, its own directory, its own
      // env with its own path prefix — is unchanged; what it no longer needs is
      // a second Cloud Run service, an invoker binding so the platform can probe
      // it, and a URL for the edge to route to.
      //
      // Its release is deliberately NOT run here. A release on this runtime is a
      // process in the same spec, run by the node before anything else starts,
      // and running it from the control plane would be a migration racing the
      // one the node is about to run.
      if (placeOnNode) {
        // A REFERENCE the node can resolve, and pinned if we can pin it.
        //
        // `image` here is a bare repository path — Cloud Run fills in `:latest`
        // and the node does not: containerd answered `failed to resolve
        // reference … : object required` and the sibling never started. Digest
        // first for the reason the primary is deployed by digest at all: a tag
        // is a name, and "the new version" should be a fact.
        const pushed = `${image}:latest`;
        const digest = await resolveImageDigest(pushed);
        const ref = digest ? `${image}@${digest}` : pushed;
        const proc: AgentProcess = {
          name: svc.name || label,
          kind: "web",
          command: ["/bin/sh", "-c", plan.run],
          image: ref,
          prefix: servicePath(svc),
          env: Object.fromEntries(
            env
              .map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)] as const)
              .filter(([k]) => k),
          ),
        };
        log(`${servicePath(svc)} → ${label} on the node, beside its primary`);
        return { ok: true, name, process: proc };
      }

      const relS = await runRelease({ lane: siblingLane, service: name, image, env, release: siblingRelease });
      if (!relS.ok) return { ok: false, name, error: relS.error };
      log(generatedBuild ? `Deploying ${label} from its own image…` : `Deploying ${label} on the prebuilt ${lang} runner…`);
      try {
        const args = deployArgs({
          lane: siblingLane, service: name, serviceFlags: siblingFlags, appFlags: siblingApp,
          // Its OWN envelope, for the same reason it gets its own env and its own
          // facts: `scale` is per service in the schema, and a Django API beside
          // a Next frontend is not the same size as the frontend.
          image, port: await servePortFor(image), scale: withScale(svc.scale), cloudsql,
          existingScoped: await liveContainerShape(name),
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
        // A sibling that will not start is the case this was written for: the
        // FastAPI template's API died on import and the deploy blamed $PORT.
        return {
          ok: false, name,
          error: await withAppLog(name, `Deploying ${label} failed: ${e instanceof Error ? e.message : String(e)}`),
        };
      }
    };

    /**
     * Build the app's image. The ONE place in this file that does.
     *
     * It is defined before the fork because both runtimes need it, and it is one
     * function rather than two because a second copy of "submit the build, read
     * the log back if it fails" is a worse outcome than the bug it would fix.
     *
     * The bug it does fix: this used to sit inside `runDeploy`, and
     * `runFleetDeploy` never calls `runDeploy`. So the fleet branch resolved its
     * image as `processImage` — the literal string `${IMAGE}:latest`, a tag name
     * and not evidence that a build ran — and placed it. A first-ever fleet
     * deploy failed on an image that was never pushed; every redeploy after that
     * resolved the tag to whatever the last Cloud Run build had left there,
     * placed it successfully, and marked the app live. The customer's new code
     * was reported shipped and the fleet went on serving the previous version.
     * A thing accepted, confirmed, and then not applied is the one failure this
     * platform is built not to have, and the silent one is the worse half.
     *
     * The `build` stage is recorded here, so it is recorded once per deploy on
     * whichever branch runs — the Dockerfile lane never recorded it at all
     * before, which is the other half of "not zero times, not twice".
     *
     * A failure comes back as an error string carrying the real Cloud Build log,
     * because that string is what the repair agent is given to work from and
     * `gcloud exited 1` is not something it can fix.
     *
     * WHAT IT RETURNS IS A DIGEST, NOT A TAG
     *
     * `${IMAGE}:latest` is a constant. Returning it made every deploy after the
     * first place a spec byte-identical to the one already on the node — and the
     * agent restarts a sandbox when the image or the command CHANGES
     * (services/fleet/agent/main.go). An unchanged string is not a change, so it
     * stopped nothing and pulled nothing; `EnsureImage` would not have saved it
     * either, because `GetImage("slug:latest")` resolves out of the node's own
     * content store without asking the registry. The probe then got its 200 from
     * the sandbox that was already serving, the verdict passed, and the customer
     * was told their new version had shipped.
     *
     * So the tag is resolved to the digest it means AT THIS MOMENT, once, here —
     * where the build result is produced, so the fleet branch and the Cloud Run
     * branch cannot end up holding different references to "what this deploy
     * built". This is the same move `baseImage` already makes forty lines into
     * the render for the same reason, and the comment there names the defect
     * class: "the `:latest` defect the version resolver exists to kill".
     *
     * It differs from that one in being FATAL. Pinning a base is an improvement
     * on what shipped before it, so an unresolvable digest there costs
     * reproducibility and nothing else. Here the tag is not a lesser answer, it
     * is the bug: falling back to it would place a reference that cannot express
     * "this is new code" and would hide that behind a deploy reporting success.
     */
    /**
     * The port this deploy serves on, decided once and reused.
     *
     * Memoised because both runtimes ask, and the answer costs a registry round
     * trip: two manifest reads and a blob. Announced when it is NOT 8080, which
     * is the only case where a person needs to know — and the case that used to
     * present as an app that came up, answered fine, and was rolled back with
     * "the fleet router answered, not the app".
     */
    // Keyed by image, not one value for the deploy: a multi-service app deploys
    // a frontend and an API from DIFFERENT images, and one cached number would
    // hand the second whatever the first happened to expose.
    const servePortMemo = new Map<string, number>();
    const servePortFor = async (builtImage: string): Promise<number> => {
      const cached = servePortMemo.get(builtImage);
      if (cached !== undefined) return cached;
      const exposed = builtImage ? await imageExposedPort(builtImage) : null;
      const port = choosePort(activePlan?.port, exposed);
      if (port !== DEFAULT_PORT) {
        const from = typeof activePlan?.port === "number" && activePlan.port === port
          ? "your app declares it"
          : "the image exposes it";
        log(`Serving on port ${port} — ${from}. PORT is set to the same value, so an app that reads it lands there too.`);
      }
      servePortMemo.set(builtImage, port);
      return port;
    };

    const buildImage = async (): Promise<{ ok: true; image: string } | { ok: false; error: string }> => {
      if (!useDockerBuild && !serviceless) {
        // Only the buildpack lane reaches here: its image is produced as a side
        // effect of `run deploy --source` and named by Cloud Run, so there is
        // nothing to build ahead of the delivery. `runDeploy` knows that and
        // never asks; `fleetEligibility` refuses the lane outright for the same
        // reason. This is the answer if a third caller ever appears, and it is a
        // refusal rather than a shrug — placing an image nobody built is exactly
        // what this function was extracted to prevent.
        return { ok: false, error: "this lane has no image of its own to build before the deploy" };
      }
      // Kept for the error path. `gcloud builds submit` reports the failure in
      // its own output long before the build log is fetchable, and the last
      // lines of it are the only diagnosis available when the log read fails.
      const btail: string[] = [];
      const onBuild = (l: string) => { btail.push(l); if (btail.length > 60) btail.shift(); buildLine(l); };
      try {
        await stages.around("build", async () => {
          const args = useDockerBuild
            ? ["builds", "submit", dir, "--region", REGION, "--project", PROJECT, "--config", join(dir, "cloudbuild.yaml"), ...buildIdentityArgs()]
            // The one lane where skipping the Cloud Run deploy would skip the
            // BUILD: buildpacks run inside `run deploy --source`, so with no
            // service there is nothing to produce an image. `builds submit
            // --pack` is the same builder without the deploy, which is exactly
            // what a worker-only app needs.
            //
            // NOT `--source` on the worker pool itself, though it accepts one:
            // that would rebuild the app once per process, on a lane whose
            // release job already pays for the build twice and says so.
            //
            // No `--service-account` here, and it is not an oversight. This is
            // the one submit that writes no cloudbuild.yaml, so it has no
            // `logging: CLOUD_LOGGING_ONLY` — and Cloud Build REFUSES a
            // user-specified build account unless a logging destination is set,
            // which would turn a scoped identity into a failed deploy. The
            // buildpack lane is what step 4 deletes anyway; it keeps the default
            // account until it goes.
            : ["builds", "submit", dir, "--region", REGION, "--project", PROJECT, `--pack=image=${IMAGE}:latest`];
          if (useDockerBuild) log(`Building with layer cache (${builder}) — the first build warms it, later ones are fast…`);
          else log("Building with buildpacks — no service to deploy, so the image is built directly…");
          const hb = setInterval(() => log("building…"), 8000);
          builds.reset();
          try {
            await run("gcloud", args, onBuild);
          } finally { clearInterval(hb); }
        });
      } catch (e) {
        const buildLog = await builds.error();
        const reason = buildLog
          || btail.filter((l) => /error|invalid|denied|must|logging|permission|quota|not found/i.test(l)).slice(-6).join("\n")
          || btail.slice(-6).join("\n")
          || (e instanceof Error ? e.message : String(e));
        return { ok: false, error: failureSentence("Build failed", reason) };
      }
      const digest = await resolveImageDigest(`${IMAGE}:latest`);
      if (!digest) {
        // Ours, not the repository's — the build succeeded and pushed. Worded to
        // match deploy-errors.ts's registry rule so `classify` blames the
        // platform: sending a repair agent to edit a customer's app over a
        // registry that would not answer costs ~$12-15 and finds nothing.
        return { ok: false, error: `the image digest could not be resolved: the build pushed ${IMAGE}:latest, `
          + `and the registry did not say which image that now names. Deploying the tag instead would silently ship the previous version.` };
      }
      log(`Built ${digest.slice(0, 19)}… — deployed by digest, so "the new version" is a fact rather than a tag.`);
      return { ok: true, image: `${IMAGE}@${digest}` };
    };

    const runDeploy = async (): Promise<{ ok: boolean; url?: string; error?: string }> => {
      if (staticServe) return runStatic(staticServe);
      // Read once, before any lane runs: the container shape belongs to the
      // service that already exists, and every lane below has to agree with it.
      const existingScoped = await liveContainerShape(slug);
      // Cloud Run cannot rename the container of a live service, and a Cloud SQL
      // sidecar requires named ones — so an app that already exists and then
      // gains a database is undeployable until its service is recreated. The
      // measurements are in `needsServiceRecreate`'s own comment; the short
      // version is that every other transition was tried against the real API
      // and rejected, including naming the container with no sidecar at all.
      if (needsServiceRecreate({ cloudsql, existingScoped })) {
        log("This app gained a database, and Cloud Run cannot add one to a service that was built without it — recreating the service. Its url and revision history are replaced; the database, the secrets and the images are not touched.");
        try {
          await deleteRunService(slug);
        } catch (e) {
          // Not fatal, and not silent. The deploy below fails on its own with
          // the container error, which is the same outcome; saying why here is
          // what stops the next reader chasing an imaginary port problem.
          log(`! could not recreate the service — the deploy below will fail on the container shape: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
        }
      }
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
              await run("gcloud", ["builds", "submit", dir, "--region", REGION, "--project", PROJECT, "--config", join(dir, "cloudbuild.yaml"), ...buildIdentityArgs()], buildLine);
            } finally { clearInterval(hb); }
          });
        } catch (e) {
          const buildLog = await builds.error();
          return { ok: false, error: failureSentence("Prepare failed", buildLog || (e instanceof Error ? e.message : String(e))) };
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
          image, port: 8080, scale, cloudsql, existingScoped,
        }));
      }
      if (useDockerBuild) {
        const image = await buildImage();
        if (!image.ok) return { ok: false, error: image.error };
        const relC = await runRelease({ lane: "container", service: slug, image: image.image, env: extraEnv, release: releaseCmd });
        if (!relC.ok) return { ok: false, error: relC.error };
        return attempt(deployArgs({
          lane: "container", service: slug, serviceFlags: deployFlags, appFlags,
          // Stated rather than left to `deployArgs`'s own default, which only
          // fills one in for a scoped service — so an author's image serving
          // anything but 8080 was deployed with no --port at all and Cloud Run
          // probed its default. Same defect as the fleet's, one runtime over.
          image: image.image, port: await servePortFor(image.image), scale, cloudsql, existingScoped,
        }));
      }
      if (serviceless) {
        const image = await buildImage();
        if (!image.ok) return { ok: false, error: image.error };
        // Released against the image that now exists, not against the source —
        // otherwise the release job pays for a second buildpack build of bytes it
        // has already built.
        const relS = await runRelease({ lane: "container", service: slug, image: image.image, env: extraEnv, release: releaseCmd });
        if (!relS.ok) return { ok: false, error: relS.error };
        return { ok: true };
      }
      const buildpack = (containerFlags?: string[]) => deployArgs({
        lane: "buildpack", service: slug, serviceFlags: deployFlags, appFlags,
        source: dir, scale, cloudsql, containerFlags, existingScoped,
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

    /**
     * The fleet branch. No Cloud Run service is created at all.
     *
     * It builds through `buildImage`, the same closure `runDeploy` builds
     * through — building is shared, it is only the delivery that forks — and it
     * places the reference that build returned rather than the tag the deploy
     * expected it to write. Those are not the same thing, and treating them as
     * the same is how this branch spent Task 7 placing the previous version of
     * the customer's code while reporting the new one live.
     *
     * A failed build is a failed deploy here exactly as it is on the Cloud Run
     * side, carrying the build's own error. There is no placement attempt after
     * one: a node given an image that does not exist fails later, further from
     * the cause, and a node given a STALE image does not fail at all.
     *
     * Verification is the load balancer with the app's own health path, because
     * that is the path real traffic takes and the one a database-backed app
     * fails on when its database is unreachable.
     */
    /**
     * The spec this deploy actually placed, kept for `assertReached`.
     *
     * Null on the Cloud Run branch and on a fleet deploy that never got as far
     * as placing. It is read only on success, so a failed verify — which
     * restores the PREVIOUS placement — never reports this one as the outcome.
     */
    let placedSpec: AppSpec | null = null;

    const runFleetDeploy = async (): Promise<{ ok: boolean; url?: string; error?: string }> => {
      if (!FLEET_LB) return { ok: false, error: "no fleet load balancer is configured" };
      const image = await buildImage();
      if (!image.ok) return { ok: false, error: image.error };

      // EVERY secret the app has, read before the stage opens so the stage
      // measures the placement rather than a Secret Manager round trip. Not
      // just the ones this deploy stored: a node is handed the whole set at
      // once, so a secret not passed is a secret the app loses.
      const secrets = await allAppSecrets(slug, secretRefs);

      // Siblings, built and folded into THIS app's placement rather than
      // deployed beside it. Before the spec, because the spec has to carry them.
      //
      // A sibling that cannot be built fails the whole deploy here, unlike on
      // Cloud Run where it is reported and the primary still ships. The
      // difference is real: there the frontend is already live on its own
      // address and tearing it down would be worse; here nothing has been placed
      // yet, so shipping half an app is a choice rather than a rescue.
      // Dependencies that run BESIDE the app, on the same machine.
      //
      // `database` and `bucket` are not here: they are provisioned before this
      // and are managed, because they are the app's data and it has to survive
      // the node. A cache is the opposite — losing it is a slow request, not a
      // lost customer — so it is a process with its own image, which is a thing
      // a placement can now express.
      const sidecarEnvs: string[] = [];
      const sidecars: AgentProcess[] = [];
      for (const declared of [...new Set((appConfig?.services ?? []).flatMap((v) => v.uses ?? []))]) {
        const spec = sidecarFor(declared);
        if (!spec) continue;
        sidecars.push({
          name: spec.name,
          kind: "worker",
          image: spec.image,
          command: spec.command,
          memoryBytes: spec.memoryBytes,
        });
        sidecarEnvs.push(...sidecarEnv(spec));
        log(`Running ${spec.name} beside your app — reachable only by it, and not persisted`);
      }

      const nodeSiblings: AgentProcess[] = [];
      for (const svc of (appConfig ? extraServices(appConfig) : [])) {
        const r = await deploySibling(svc, true);
        if (!r.ok || !r.process) {
          return { ok: false, error: r.error ?? `${servicePath(svc)} could not be prepared for the node` };
        }
        nodeSiblings.push(r.process);
      }

      // No per-secret grant for the node here, deliberately. The node's service
      // account holds roles/secretmanager.secretAccessor on the WHOLE PROJECT —
      // see services/fleet/README.md, "What the node may read".
      //
      // This code used to add one binding per secret on this branch, so that only
      // an app actually going to a node let a node read its database password.
      // That was replaced on 5 Aug 2026 by an explicit decision to widen it, for a
      // reason the narrow version could not meet: a per-deploy binding only exists
      // for apps that have been deployed SINCE the binding was introduced, so
      // moving the fleet wholesale — FLEET_PLACEMENT=1, which places every app
      // without redeploying any of them — would have started every app that has a
      // database against a 403.
      //
      // What it costs is stated rather than left to be discovered: one escape from
      // one sandbox now reads every tenant's database password, not one tenant's.
      // The nftables rule in provision.sh keeping the metadata credentials API
      // away from tenant uids is what that now rests on.

      // The `fleet` stage — placing the app on a node and checking it answers
      // from there — written from inside the branch that does the work.
      //
      // It went missing when the additive block that used to write it was
      // deleted, and nothing noticed: `stage-names.ts` still declares it in
      // LANE_KNOWN_STAGES, and a declared name that nothing writes does not
      // fail anything. It produces a table with no fleet rows in it, which
      // reads as "no app was ever placed" rather than as a missing emitter —
      // the same shape of defect the whole vocabulary file exists to prevent.
      // The size the author asked for, carried to the node.
      //
      // `buildAppSpec` used to default every app to 2 GiB / 1024 shares no
      // matter what `scale:` said, and the check that should have caught it was
      // the one throwing a false alarm two hundred lines below. An app declaring
      // `memory: 4Gi` declares it because it OOMs at 2Gi — placing it at 2Gi
      // anyway is an OOM kill on a deploy that reported success, which is the
      // same shape of defect as the tag placement above.
      //
      // `scale` is `withScale(...)`, so these are never undefined and the `??`
      // defaults inside `buildAppSpec` are not what keeps an undeclared app at
      // the 2 GiB floor — DEFAULT_SCALE is. That floor exists because Cloud
      // Run's 512Mi OOM-killed a real Node app at 564Mi before it bound $PORT.
      const placing = buildAppSpec({
        slug, image: image.image, env: [...extraEnv, ...sidecarEnvs], secrets,
        processes, healthPath: primaryHealth.health.path,
        // Belt and suspenders with the append above: `processes` already
        // carries a synthesised release entry when `releaseCmd` was set, but
        // `buildAppSpec` only adds a second when a release is not already
        // present, so passing this too can never double it.
        releaseCommand: releaseCmd || null,
        // Read at line ~1965, before the release was appended — the one moment
        // an empty process list still meant "one implicit web process". See the
        // note in buildAppSpec: by the time it sees the list, that fact is gone
        // from the list itself.
        serviceless,
        memoryBytes: memoryBytes(scale.memory),
        cpuShares: cpuShares(scale.cpu),
        // Stamped whenever this app HAS secrets, because this deploy just wrote
        // a version of every one of them. Secrets travel as names resolved to
        // `versions/latest`, so an edited .env leaves the spec byte-identical and
        // nothing restarts — the app keeps the value it booted with. Measured on
        // a worker whose token was changed in .env and redeployed onto the same
        // cached digest: the container never saw the new one.
        ...(secretRefs.length ? { secretsVersion: new Date().toISOString() } : {}),
        // What the node probes AND what it injects as PORT — one value, so an
        // app that reads the variable and an app that hardcodes its port land in
        // the same place. Without this every placement said 8080 and stock nginx,
        // serving 80, was rolled back as unhealthy while answering 200.
        port: await servePortFor(image.image),
      });
      if (nodeSiblings.length) {
        // The primary's own process, made EXPLICIT before anything is appended.
        //
        // An app that declares no processes is one implicit web process, and the
        // agent synthesises it from an EMPTY list. Appending a sibling makes the
        // list non-empty, so that synthesis stops happening and the app's own
        // program silently disappears — measured: the sibling started, the
        // primary never did, and the probe reported a routing miss.
        const own: AgentProcess[] = placing.processes?.length
          ? placing.processes
          : [{
              name: "web",
              kind: "web",
              ...(placing.command ? { command: placing.command } : {}),
              ...(placing.healthPath ? { healthPath: placing.healthPath } : {}),
            }];
        placing.processes = [...own, ...nodeSiblings];
      }
      if (sidecars.length) {
        // Appended after the same materialisation rule: a sidecar is a process
        // too, and adding one to an app that declared none would delete the
        // app's own program exactly as a sibling would.
        const own: AgentProcess[] = placing.processes?.length
          ? placing.processes
          : [{
              name: "web",
              kind: "web",
              ...(placing.command ? { command: placing.command } : {}),
              ...(placing.healthPath ? { healthPath: placing.healthPath } : {}),
            }];
        placing.processes = [...own, ...sidecars];
      }
      placedSpec = placing;

      // The half of `scale` a node has no primitive for, said out loud.
      //
      // Only the fields the author actually wrote, so an app that declared
      // nothing hears nothing. Three of the four are honoured by construction
      // and one is genuinely not, and the difference is exactly what an owner
      // needs to know — a single "some fields are ignored" would be as useless
      // as silence.
      const declaredScale = primaryConfigService?.scale;
      if (declaredScale) {
        const byConstruction = [
          declaredScale.maxInstances !== undefined && "maxInstances (the node runs one instance, which is under any ceiling)",
          declaredScale.timeout !== undefined && "timeout (nothing on the node cuts a request short)",
          declaredScale.cpuBoost !== undefined && "cpuBoost (a resident process has its full CPU share from the first instant)",
        ].filter(Boolean) as string[];
        if (byConstruction.length) log(`scale on the fleet: ${byConstruction.join("; ")}.`);
        if (declaredScale.concurrency !== undefined) {
          log(`! scale.concurrency=${declaredScale.concurrency} is NOT enforced on the fleet — the node does not cap in-flight requests the way Cloud Run does. `
            + `Your app has to limit its own concurrency.`);
        }
      }

      // The `release` stage — folded into the node's own startup ordering
      // instead of run as a Cloud Run Job, per the comment above this
      // function's own `toFleet` fork. `release` already lives in
      // LANE_KNOWN_STAGES; nothing on this branch had ever written it, so
      // `deploy_stages` held a Cloud-Run-only view of release reliability
      // without anybody having decided that on purpose (docs/research/
      // cloud-run-shape.md, "release is a full architectural fork, not a
      // branch").
      //
      // What CAN honestly be said from here, and what cannot:
      //
      // An app with no release process gets no row. Not "skipped" — skipped is
      // for a stage a lane legitimately never reaches, and this app was never
      // going to have one; a row of any outcome would be exactly the fake
      // success the ticket names ("a lie a reliability query cannot tell from
      // the truth").
      //
      // An app WITH one gets an outcome inferred from `placement.placed`, not
      // measured directly, because there is no direct measurement to take.
      // `main.go` blocks an app's own processes from starting at all until its
      // release succeeds (`blocked`/`cronBlocked`), so a placement that came up
      // is proof its release came up first — recording "ok" there is reading a
      // real invariant the agent enforces, not hardcoding a success. The
      // reverse is weaker: a placement that never answered may be a release
      // that failed, or a web process that crashed AFTER a release that
      // succeeded (`fleet-place.ts`'s own `runVerdict` cannot tell those apart
      // either, and neither can a human reading the log), and this stage
      // inherits that same fused verdict rather than resolving it. Written
      // anyway, because a wrong-but-labelled "failed" is still closer to the
      // truth than a table with no row — the same call already made for the
      // `fleet` stage and the outer activation stage this sits beside.
      //
      // The DURATION this writes is not the release's own, and cannot be made
      // to be from here. `placeOnFleet` is timed as one place→verify span; the
      // node never reports when ITS release finished — `desired.go`'s sync
      // payload carries only `ProcessFault` (written by `recordStartFailure`,
      // a process-START error, never a release one) and `ProcessState`
      // (`fleet-place.ts`'s `requiredProcesses` excludes "release" by name,
      // because a release runs once and is gone before any sync could report
      // it running). `main.go`'s own release timing (`RunToCompletion`,
      // `relFail`) lives entirely on the node and never reaches the wire. So
      // this stage's `startedAt`/`endedAt` are the same instants the `fleet`
      // stage records, release and everything it gates fused into one number —
      // an honest fact about what is measurable today, not a proxy for how
      // long the release itself took. Separating them needs the node to say
      // so, which is a change to services/fleet/agent this task does not make.
      const hasRelease = placing.processes?.some((p) => p.kind === "release") ?? false;
      const releaseHandle = hasRelease ? stages.start("release") : null;
      const placement = await stages.around("fleet", () => placeOnFleet(
        slug,
        placing,
        FLEET_LB,
        {
          chooseNode, placeApp, unplaceApp, readPlacement: placementFor, readRuntime: runtimeOf, setRuntime,
          // The deploy as a write: a row saying what shipped, and a column
          // saying which row should be running. The reconciler converges on the
          // difference, which is what makes rollback one call with an older id
          // rather than a 501.
          readDesired: desiredRelease,
          recordRelease: async (s, sp) => (await recordRelease(s, sp.image, sp)).id,
          setDesired,
          probe: (s) => fleetProbe(FLEET_LB, s, { path: primaryHealth.health.path }),
          runningOnNode: (s, n, sp) => awaitRunning(s, n, sp, runningOnNode),
          nodeFaultFor,
          // Short and recent on purpose. This runs while a person is watching a
          // deploy fail, and the useful part of a crash loop is the first thing
          // it said, repeated — not the hundred lines of it.
          recentAppLogs: async (s) =>
            (await getLogs(s, { limit: 20, freshness: "10m" })).map((l) => l.message),
          log,
        },
      ));
      if (releaseHandle) await stages.end(releaseHandle, placement.placed ? "ok" : "failed");
      return placement.placed
        ? { ok: true, url: placement.runUrl }
        : { ok: false, error: placement.reason ?? "the app did not answer from the fleet" };
    };

    if (target.reason) log(`Deploying ${slug} to Cloud Run — ${target.reason}`);
    else if (!toFleet) log(`Deploying ${slug} to Cloud Run — the fleet could take it, but it is not a canary yet`);
    else log(`Deploying ${slug} to the fleet…`);
    // `runRelease` — the lib/release-job.ts call — only ever runs from inside
    // `runDeploy`, below, and this same `toFleet` picks between that and
    // `runFleetDeploy` two lines down. So a release never runs as a Cloud Run
    // Job on this branch; it is already inside the AppSpec `runFleetDeploy`
    // places, and the agent runs it before web and worker start. Said out loud
    // rather than left to be inferred from which function is not called: the
    // release and the app can never disagree about which runtime they are on.
    if (toFleet) log("release runs on the node, before the app starts");
    /**
     * What a repair agent's `redeploy` tool actually does.
     *
     * The SAME branch this deploy took, and it has to be, because the deploy has
     * already committed to a runtime in ways nothing downstream can undo.
     * `deployTarget.databaseAddress` resolved to FLEET_DB above, so `DATABASE_URL`, `PGHOST` and
     * `POSTGRES_HOST` all name 10.200.0.1 — the sandbox bridge gateway, an
     * address no Cloud Run revision can route to. A repair that redeployed to
     * Cloud Run therefore produced an app that starts, serves its homepage,
     * answers the probe 200 and fails every request that touches data. On a
     * repeat it was worse: `placeOnFleet` had already restored the previous
     * placement, so the node went on serving the old version while `markAppLive`
     * wrote a Cloud Run url over the top of it — two live runtimes for one app,
     * which is the defect class this whole piece exists to end.
     *
     * A human ruled that the repair agent keeps running on fleet failures (see
     * the ledger, Task 9). This is not that fuse. It is the agent redeploying to
     * where the app lives.
     */
    const redeploy = toFleet ? runFleetDeploy : runDeploy;
    const firstAttempt = stages.start(ACTIVATION_STAGE);
    let result = toFleet ? await runFleetDeploy() : await runDeploy();
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
      const resolvedApp = resolveFrom(appConfig, configWasWritten ? "config" : "inferred", runtimePinned);
      const primaryEnvelope = buildEnvelope(resolvedApp.services[0], resolvedApp);
      assertReached(primaryEnvelope, {
        revisionEnv,
        hasRevision,
        releaseCommand: releaseCmd,
        argv: lastArgv,
        hasDatabase: Boolean(databaseUrl),
        // What the fleet branch produced instead of an argv. Null on the Cloud
        // Run branch, where `lastArgv` is the evidence — see DeployOutcome.
        placed: placedSpec,
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
      /**
       * Put the app back on the last version that worked.
       *
       * A deploy that FAILS TO START never takes traffic — Cloud Run refuses to
       * promote a revision that cannot pass its own startup probe, and gcloud
       * errors out. This is for the other case, which is the one that hurts: the
       * container starts, binds $PORT, becomes Ready, takes 100% of traffic, and
       * then answers 500 to everything. The revision is healthy by Cloud Run's
       * definition and the app is down by everyone else's.
       *
       * Until now that stayed live until a person noticed and ran `supersonic
       * rollback` — which is exactly the manual command this makes automatic, and
       * the plan is right that "no operator" is not credible while a broken deploy
       * outlives the deploy that made it.
       *
       * `rollback()` already skips revisions that never became Ready, which
       * matters here more than anywhere: the newest revision is the broken one, and
       * "the one before" is not the same as "the last one that can serve".
       *
       * Never fatal, and never for static — a static app has no service of its own
       * and its previous release is a different mechanism entirely.
       *
       * WHAT "ROLL BACK" MEANS ON THE FLEET, AND WHY IT ISN'T THE SAME OPERATION.
       *
       * `rollback()` is Cloud-Run-shaped end to end: `gcloud run revisions list`
       * reads a history that only Cloud Run keeps. The fleet has no such history to
       * read — `fleet_placements` stores one `spec` row per `(slug, node)`,
       * overwritten on every deploy (see docs/adr/0001-fleet-is-the-only-target-
       * for-server-apps.md, which names instant revision rollback as one of four
       * capabilities that do not survive the move). Calling `rollback()` here for a
       * fleet app used to throw `gcloud run revisions list` against a service that
       * was never created, caught and logged as noise — a silent no-op dressed up
       * as a safety net.
       *
       * The only copy of "the version that was working" a fleet deploy ever has is
       * read once, in memory, by `placeOnFleet` itself — right before it overwrites
       * the placement row (fleet-place.ts:509-510, "read BEFORE placing"). If THAT
       * attempt's own verify then fails, `placeOnFleet` already puts it straight
       * back (fleet-place.ts:638-644) before this function is ever called — or, on
       * a first deploy, correctly drops the placement rather than leaving it
       * pointing at something that never served. By the time we get here there is
       * no second, independent copy of "previous" left to act on: the one chance to
       * use it was inside that same call, and it was already taken (or there was
       * nothing to take). So this function's job for a fleet app is not to perform
       * a restore — it has nothing left to restore with — but to say, honestly,
       * which of those two things already happened. Inventing a fleet revision
       * history here just to give this function something to do would be recording
       * a capability the platform does not have, which is exactly the dishonesty
       * the dedicated `/rollback` route (`rollback/route.ts:13-26`) already refuses
       * to commit for a manual rollback. This is the same refusal, automatic.
       */
      const rollBackToLastGood = async (): Promise<string | null> => {
        if (staticServe || serviceless) return null;
        // The same capability question the domain-mapping branch asks below
        // (`!deployTarget.supports("domainMapping")`, ~300 lines on) — routed
        // through `supports(...)` rather than `toFleet` directly so the two
        // places this function's job forks on "which target" ask it the same
        // way. See lib/deploy-target.ts: this is the guard its own doc names
        // as the reason `autoRollbackOnFailure` exists as a capability at all.
        if (!deployTarget.supports("autoRollbackOnFailure")) {
          // Guarded the same way the Cloud Run branch below guards `rollback()`:
          // this runs on the failure path of every fleet deploy, with things
          // already degraded, and a Postgres hiccup here must not escape —
          // caught, it is a fact this function can report ("could not check");
          // uncaught, it replaces the deploy's real error with a raw database
          // message at the outer catch and skips the error event, the fix
          // prompt, the non-Pro upgrade path and the failure record that catch
          // has no way to produce for a thrown, unclassified error.
          let stillPlaced: { node: string; spec: AppSpec } | null;
          try {
            stillPlaced = await placementFor(slug);
          } catch (e) {
            const why = e instanceof Error ? e.message : String(e);
            log(`! could not check the fleet placement (${why})`);
            return null;
          }
          if (stillPlaced) {
            // Not phrased as "we rolled back": nothing here did. The version now
            // placed is either the one `placeOnFleet` restored moments ago, on
            // THIS attempt's own failed verify, or the one that was never touched
            // because this attempt never got as far as placing anything. Either
            // way it is the fact worth telling the user — not the mechanism.
            log(`${slug} is on the version that was working before this deploy — the fleet has no revision history to roll back further than that.`);
            return "The previous version is still (or already back) serving — the fleet keeps one spec per app, not a history, so this is as far back as an automatic rollback can go.";
          }
          // No placement at all: either this was the first deploy (nothing ever
          // served, so there is nothing to fall back to) or the one placement
          // attempt failed verify and, having no previous spec of its own to
          // restore, correctly unplaced rather than leaving a broken address on
          // the books. Both are the same user-facing fact: there is no previous
          // version of this app on the fleet.
          log(`No previous version of ${slug} exists on the fleet to roll back to — this looks like its first deploy. Fix the error above and redeploy.`);
          return "Nothing to roll back to on the fleet: this app has no previous placement. Fix the error and redeploy.";
        }
        try {
          const to = await rollback(slug);
          const note = `Rolled back to ${to} — the previous version is serving again while you fix this.`;
          log(note);
          return note;
        } catch (e) {
          // A first deploy has nothing to go back to, which is the common case
          // here and not worth alarming anybody about.
          const why = e instanceof Error ? e.message : String(e);
          if (!/no previous revision|never started/i.test(why)) log(`! could not roll back (${why})`);
          return null;
        }
      };

      // Where it died, attached once, before the failure fans out.
      //
      // The ordinary deploy failure RETURNS a result rather than throwing, so it
      // never reaches the outer catch — annotating only there covered the rare
      // path and missed the dominant one. Done here instead, so `classify`, the
      // deploy row, the error event, the fix prompt and the repair agent all see
      // the same sentence.
      //
      // Appended as its own line: `classify` reads the FIRST line as the verdict,
      // and a stage name is context rather than a symptom.
      const failedIn = stages.failedStage();
      if (failedIn && result.error && !result.error.includes("failed during:")) {
        result = { ...result, error: `${result.error}\n  (failed during: ${failedIn})` };
      }
      const blame = classify(result.error);
      // The cause, recorded before the verdict branches the flow — this is the
      // last point at which it is still intact. Below, a platform verdict
      // returns, a non-Pro app verdict returns, and the repair agent overwrites
      // `deploys.error` with its own summary; `deploys` also holds one row per
      // app, so the next deploy discards whatever survived that.
      const failure = new FailureRecorder();
      await failure.record({
        runId: input.runId ?? null,
        slug,
        ownerId: ownerId ?? null,
        stage: failedIn,
        cause: causeOf(result.error),
        blame: blame.blame,
      });
      if (blame.blame === "platform") {
        if (blame.reason && blame.reason !== result.error) log(blame.reason);
        // Folded into `result.error` itself, not logged and dropped — so the
        // deploy row, the error event and the fix prompt below all carry the
        // same honest account of what rollback did (or, on the fleet, could not
        // do), matching `failedIn`'s append two lines above rather than adding a
        // second, differently-visible channel for the same fact.
        const rollbackNote = await rollBackToLastGood();
        if (rollbackNote) result = { ...result, error: `${result.error ?? "deploy failed"}\n\n${rollbackNote}` };
        setDeploy(slug, { status: "failed", error: result.error ?? "deploy failed" });
        if (ownerId && ownerWorkspace) await markAppFailed(slug).catch(() => {});
        send({ type: "error", message: result.error });
        await failure.repaired("skipped", null);
        return;
      }
      // Whether the repair agent runs at all — three questions now, not one.
      //
      // This is the single most expensive thing the platform can do on a user's
      // behalf: an LLM session that reads a repo, edits it, and redeploys, up to
      // MAX_REDEPLOYS times. Per-RUN cost was already bounded (MAX_STEPS,
      // MAX_REDEPLOYS, REPAIR_MAX_CALLS in lib/agent.ts and lib/agents/index.ts).
      // What was never bounded is how many runs a month can hold, and that is
      // the hole a free tier would have opened.
      let runRepair = false;
      let declined = "";
      if (limits.autoFix) {
        runRepair = await countIfUnder(ownerId, "agentRuns", limits.monthlyAgentRuns);
        if (!runRepair) declined = agentLimitMessage();
      } else if (limits.lifetimeFreeFixes > 0) {
        // The one free repair, spent here: on a deploy that has ACTUALLY FAILED,
        // rather than on the first deploy an account makes. Spent on the first
        // deploy it would usually be spent on one that was going to succeed —
        // costing us a session and showing the user nothing. Spent on the first
        // failure it is the one moment the product does something no other
        // deploy tool does.
        //
        // Claimed before the agent starts rather than after it succeeds: a crash
        // mid-run must not hand out a second session. `claimFreeFix` is a
        // conditional UPDATE, so two deploys failing in the same instant cannot
        // both take it, and it fails CLOSED — unlike every other limit here —
        // because the fallback costs a paste-ready prompt and the alternative
        // costs an unbounded LLM session.
        runRepair = await claimFreeFix(ownerId);
        if (runRepair) log("Using your one free auto-fix — the repair agent is taking this one.");
      }
      if (!runRepair) {
        // The rollback's own outcome, appended rather than dropped: on the fleet
        // there is no previous version to restore, and saying so is the whole
        // point of the change that taught this function to return a note. The
        // three sibling call sites already do this; this one arrived from the
        // repair-gating work and had no reason to know.
        const rollbackNote = await rollBackToLastGood();
        if (rollbackNote) result = { ...result, error: `${result.error ?? "deploy failed"}\n\n${rollbackNote}` };
        setDeploy(slug, { status: "failed", error: result.error ?? "deploy failed" });
        if (ownerId && ownerWorkspace) await markAppFailed(slug).catch(() => {});
        log(declined || "Deploy failed — here's a fix to hand your coding agent (auto-fix is on Pro).");
        send({
          type: "error",
          message: result.error,
          fixPrompt: fixPrompt(slug, result.error ?? "deploy failed"),
          upgrade: true,
        });
        await failure.repaired("skipped", null);
        return;
      }
      log("Repair agent taking over — reading the repo, fixing, retrying…");
      // Timed separately: a deploy the agent rescues is a very different
      // experience from one that worked first time, and a median that mixes
      // the two hides how often we are paying for it.
      // Whether to run a repair agent AT ALL. The value is the string
      // "opencode" for historical reasons — it predates there being a choice of
      // backend — and it no longer names which one runs. DEPLOY_AGENT does that.
      const useAgent = process.env.DEPLOY_ENGINE === "opencode";
      if (useAgent) log(`Repair engine: ${agentName()}`);
      // Snapshot first, so whatever the agent changes can be handed back. Its
      // edits live in a scratch copy that is deleted when the deploy ends, so
      // until now a rescued app left the user's own folder still broken — and
      // their next deploy shipped the same code again.
      const snapshotted = await snapshotSources(dir);
      const repair = stages.start("repair-agent");
      const fixed = useAgent
        ? await agentRepair({
            dir, slug, initialError: result.error ?? "unknown", plan: activePlan, redeploy, log,
            runId: input.runId,
            // Named, not inferred: the agent is told which runtime its
            // `redeploy` reaches, so its prompt cannot describe one while the
            // closure runs the other.
            runtime: toFleet ? "fleet" : "cloudrun",
            // What the platform DID, not only what it planned. Without this the
            // agent reads every failure as the app's fault, because the repo is
            // the only surface it can change — which is how a Telegram bot got an
            // http.server shim written into it to satisfy a port check that should
            // never have applied.
            facts: {
              lane,
              serviceless,
              processes: processes.map((pr) => ({ name: pr.name, kind: pr.kind, command: pr.command })),
              runtime: pinned && runtimePinned
                ? { pinned: pinned.spec, from: pinned.from, running: RUNTIME_VERSIONS[pinned.language] }
                : null,
              ownedEnv: extraEnv.map((e) => e.slice(0, e.indexOf("="))).filter(Boolean),
              attached: resourcePlan.attach.map((r) => r.kind),
            },
          })
        : await repairDeploy({
            dir, slug, initialError: result.error ?? "unknown", redeploy, log,
            runtime: toFleet ? "fleet" : "cloudrun",
          });
      await stages.end(repair, fixed.ok ? "ok" : "failed");
      if (fixed.ok) {
        await failure.repaired("fixed", fixed.summary);
        result = { ok: true, url: fixed.url };
        log(`Agent fixed it (${fixed.changes.join(", ")})`);
        // Keep what the repair taught us about BUILDING this app, so the next
        // deploy starts from it instead of rediscovering it.
        //
        // Read back off the Dockerfile the agent left rather than from its own
        // description of what it did: "Fixed: Dockerfile" is not a package list,
        // and the file is the only statement that cannot be a paraphrase. Only
        // apt packages, because those are what survive a template change — see
        // build-hints.ts for why the file itself is deliberately not stored.
        try {
          const finalDockerfile = existsSync(join(dir, "Dockerfile")) ? readFileSync(join(dir, "Dockerfile"), "utf8") : "";
          const learned = aptPackagesIn(finalDockerfile);
          if (learned.length && await rememberBuildHints(slug, learned)) {
            log(`Remembered for next time: this app's build needs ${learned.join(", ")}`);
          }
        } catch { /* a hint we failed to keep costs a slower repair, never a deploy */ }
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
        const rollbackNote = await rollBackToLastGood();
        const summary = rollbackNote ? `${fixed.summary}\n\n${rollbackNote}` : fixed.summary;
        setDeploy(slug, { status: "failed", error: summary });
        await failure.repaired("gave-up", summary);
        if (ownerId && ownerWorkspace) await markAppFailed(slug).catch(() => {});
        send({ type: "error", message: summary });
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
    // Not when the app went to a node: its siblings are already in the
    // placement, running beside it, and deploying them again to Cloud Run would
    // be a second copy of each with a second database connection.
    if (appConfig && result.ok && !toFleet) {
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
    // The app's OTHER processes: its workers and its crons.
    //
    // Additive, and that is deliberate. `web` still deploys exactly as it did
    // above, `release` still runs through lib/release-job.ts, and everything here
    // is a resource that did not exist before — so an app with no processes
    // declared takes a path identical to yesterday's, and an app with them gets
    // more without its web service moving.
    //
    // Reported and recorded, never fatal: a worker that fails to come up leaves
    // an app whose frontend is live, and tearing the frontend down would make
    // that strictly worse. Same rule as a sibling, for the same reason.
    // The buildpack lane's image only exists once `run deploy` has run, and its
    // name is Cloud Run's to choose — so it is read off the service that was
    // just deployed rather than guessed. Null means the read failed, and a
    // worker with no image is skipped loudly inside deployProcesses rather than
    // deployed from a source tree that would build a third time.
    //
    // On the fleet branch this reads back the same image `runFleetDeploy`
    // already placed — workers and crons still deploy through Cloud Run
    // regardless of which runtime serves the web process, so this lookup
    // still has to happen even when the web process itself did not go there.
    let built: string | null = null;
    let allRefs: SecretRef[] = [];
    if (result.ok && !staticServe) {
      built = processImage ?? await liveContainerImage(slug);
      // EVERY secret the app has, not just the ones this deploy stored. The
      // service path can pass the delta because `--update-secrets` merges; these
      // primitives are deployed with `--set-secrets`, so a secret not passed is a
      // secret dropped. See allAppSecrets for the deploy this cost.
      allRefs = await allAppSecrets(slug, secretRefs);
      const allSecrets = setSecretsFlag(allRefs);
      await stages.around("processes", () => deployProcesses({
        slug, dir, lane, image: built ?? undefined,
        env: extraEnv, secrets: allSecrets || null,
        cloudsql, labels: labelPairs, config: primaryConfigService,
        // The node owns this app's workers and crons, so Cloud Run must own
        // neither — and passing NO processes is how that is said, because the
        // orphan pass inside `deployProcesses` then deletes the worker-pools and
        // jobs this app already has there. Nothing new is needed for the
        // removal; that machinery exists and this is exactly what it is for.
        //
        // Until now this ran unguarded, and for a web app on the fleet the
        // duplicate workers were the documented status quo. For a WORKER-ONLY
        // app they are not survivable: the entire app would run twice — a
        // Telegram bot double-polling getUpdates, a queue consumer
        // double-consuming — and the new verdict would truthfully report the
        // node running it while the Cloud Run copy ran beside it. The guard
        // belongs in the slice that first makes an app depend on the node alone.
        processes: toFleet ? FLEET_OWNS_PROCESSES : processes,
        log,
      })).catch((e) => log(`! processes: ${e instanceof Error ? e.message : String(e)}`));
    }

    // The two routing models are mutually exclusive: a per-app domain
    // mapping points straight at Cloud Run, which a sealed app refuses.
    // `db-proxy` is a `remove` kind, and this is what removing it means for a
    // service that was attached to Cloud SQL under the old model.
    if (!wants("db-proxy") && !staticServe) await clearStaleCloudSql(slug, log);

    if (!wants("domain")) {
      // A worker-only app has no address, and saying so plainly is the point. It
      // is not "deployed but broken" and it is not waiting for a URL — a Telegram
      // bot is reached through Telegram. Creating a domain mapping here would
      // point a hostname at a Cloud Run service that does not exist, and the
      // failure would read as the deploy having gone wrong.
      //
      // And the case that had no code at all until the resource engine: an app
      // that HAD a web process and becomes worker-only leaves a live hostname
      // pointing at a service that no longer serves. `remove` means remove.
      await removeDomainMapping(slug, log);
      log(`Running — this app has no web process, so it has no URL. Logs: supersonic logs ${friendlyName}`);
    } else if (SEAL_APPS || staticServe || !deployTarget.supports("domainMapping")) {
      // A static app has no service of its own to map a name onto — the
      // proxy routes it by apps.run_url to the shared static server, the
      // same way it routes everything else. So the visibility rules apply
      // with no special case, and there is no per-app mapping to create.
      //
      // A fleet app belongs in this branch for a different reason: the
      // per-app mapping this `else` creates points `<slug>.supersonic.cv`
      // straight at a Cloud Run SERVICE, and a fleet app was deliberately
      // never given one — see docs/research/cloud-run-shape.md, "the gap".
      // The call used to run anyway, fail against a service that doesn't
      // exist, get caught, and get logged on every such deploy: a permanent
      // error line in a healthy app's log, teaching everyone that errors
      // there are normal. `deployTarget.supports("domainMapping")` is the
      // capability question that call site should have asked from the
      // start (see lib/deploy-target.ts) — asking it here means a fleet app
      // is reached the same way a sealed or static one already is, through
      // the proxy's own wildcard `*.supersonic.cv`, once its `run_url` is
      // the fleet load balancer address `markAppLive` writes below.
      log(`Live at ${slug}.supersonic.cv`);
    } else {
      await createDomainMapping(slug, log);
    }
    setDeploy(slug, { status: "live", url: result.url });

    // A deploy that went to Cloud Run says so, and that had no writer.
    //
    // `setRuntime` was only ever called by placeOnFleet and by its rollback, so
    // an app that had been placed on the fleet and then deployed to Cloud Run
    // kept `runtime = 'fleet'` AND kept its placement row. `desiredFor` hands a
    // node every placement whose app reads 'fleet', so the node went on running
    // a second copy of an app Cloud Run was already serving — two live runtimes
    // for one app, which is the defect class this whole move exists to end,
    // arriving through the one door nobody had closed.
    //
    // Seen on p6mx8 the moment it was withdrawn from the canary: Cloud Run
    // served it while fleet-lab-1 kept failing its release every few minutes
    // against secrets it cannot read.
    //
    // OUTSIDE the owner/workspace guard below, deliberately. That guard is
    // there because run_url and the app row are owner-scoped; WHERE AN APP RUNS
    // is not. An app whose workspace is unknown must still stop being handed to
    // a node.
    //
    // Unconditional on this branch rather than guarded by a read: for an app
    // that was always on Cloud Run both statements are no-ops, and a guard
    // would cost the same query it saves. setRuntime('cloudrun') drops the
    // placement itself, so the node stops on its next reconcile without being
    // told anything.
    if (!toFleet) await setRuntime(slug, "cloudrun");

    if (ownerId && ownerWorkspace) {
      // The flip, and the only write of run_url. `result.url` is the fleet's
      // load-balancer address on the fleet branch and the Cloud Run url on the
      // other — whichever branch ran is the one that proved this address live.
      // `!serviceless` is the same fact the repair agent is already told at the
      // top of this file and that declaredNeeds.web is already computed from —
      // this is where it finally gets persisted, so the edge can stop calling a
      // working bot a failed deploy.
      // A deploy that went to Cloud Run says so, and that had no writer.
      //
      // `setRuntime` was only ever called by placeOnFleet and by its rollback,
      // so an app that had been placed on the fleet and then deployed to Cloud
      // Run kept `runtime = 'fleet'` and kept its placement row. `desiredFor`
      // hands a node every placement whose app reads 'fleet', so the node went
      // on trying to run a copy of an app Cloud Run was already serving — two
      // live runtimes for one app, which is the defect class this whole move
      // exists to end, arriving through the one door nobody had closed.
      //
      // Seen on p6mx8 the moment it was withdrawn from the canary: Cloud Run
      // served it, and fleet-lab-1 kept failing its release every few minutes
      // against secrets it cannot read.
      //
      await markAppLive(slug, result.url ?? "", null, routes, !serviceless);
      // Not awaited: the deploy is finished, and a thumbnail must never hold it.
      // Skipped entirely for a worker-only app: there is no page to photograph,
      // and asking the shot service for one produces a screenshot of an error
      // that then sits on the dashboard as this app's picture.
      if (!serviceless) {
        // Visibility read here rather than guessed: a private app on a node
        // would be photographed at its sign-in page, and that is filed as the
        // app's preview.
        void getAppBySlug(slug)
          .then((row) => requestThumbnail(slug, result.url ?? "", row?.visibility))
          .catch(() => { /* a thumbnail is never worth failing a deploy */ });
      }
    }
    // A static app's run_url is the shared static server, which is useless to
    // show someone. A worker-only app has no URL at all, and sending the app's
    // would-be hostname would put a dead link in front of whoever deployed it.
    send({
      type: "done", slug,
      url: serviceless ? undefined : SEAL_APPS || staticServe ? `https://${slug}.supersonic.cv` : result.url,
      // Every decision this deploy made, so the next one is not a fresh guess and
      // the author can see what was chosen FOR them.
      //
      // A lockfile, not a form: a first deploy on a bare folder still requires
      // nothing, and this appears only after a green one. It inverts `supersonic
      // init`, which writes "a DRAFT for an agent to correct" before anything has
      // been proven.
      //
      // A SIDECAR rather than fields in supersonic.json. The no-new-schema rule is
      // in force until deploys work, and `parseAppConfig` has a fixed key list
      // that silently drops what it does not know — which is the exact defect that
      // rule exists to stop, and adding to it here would be committing it while
      // citing it. The CLI writes the file; the server has a clone, not the user's
      // folder, so a git deploy gets nothing until there is a PR-opening step.
      decided: renderInput ? {
        language: renderInput.language,
        version: renderInput.version ?? null,
        // Where the version came from is the half that matters. "platform
        // default" is the only answer the author did not choose, and therefore the
        // only one that can move under them.
        versionFrom: renderInput.toolchains?.[0]?.versionFrom ?? pinned?.from ?? "platform default",
        image: renderInput.image ?? null,
        // `|| null`, not `?? null`: `inDir` returns "" for a command that is
        // present and empty, and `"build": ""` in a lockfile reads as "it builds
        // with nothing" rather than "there is no build step".
        install: (renderInput.toolchains?.[0]?.install ?? renderInput.install) || null,
        build: (renderInput.toolchains?.[0]?.build ?? renderInput.build) || null,
        start: renderInput.command,
        needs: renderInput.needs ?? [],
        toolchains: (renderInput.toolchains ?? []).map((t) => ({ language: t.language, version: t.version ?? null, dir: t.dir })),
        release: releaseCmd || null,
        database: s.database?.engine ?? null,
      } : undefined,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Which stage it died in, recorded with the failure.
    //
    // Part 5 needs this and nothing had it: `classify` was handed a bare string
    // and had to infer platform-versus-app blame from its wording alone, which is
    // how one `permission denied` inside a build log spoke for the whole deploy.
    // A stage is a fact about WHERE the failure happened, and it does not have to
    // be guessed from the message.
    //
    // Appended rather than prefixed so the first line of the error — the thing
    // `classify` now reads as the verdict — keeps saying what went wrong rather
    // than where.
    const stage = stages.failedStage();
    setDeploy(slug, { status: "failed", error: stage ? `${msg}\n  (failed during: ${stage})` : msg });
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

