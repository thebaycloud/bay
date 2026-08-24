import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPool } from "./db";
import { HTTP_TIMEOUT_MS, accessToken, identityToken, imageTag, runJobUrl, runServiceUrl } from "./gcp-rest";
import { ASSETS_BUCKET } from "./static-release";
import type { RepoLink } from "./app-repos";

const DB = "supersonic_platform";
const PROJECT = "supersonic-deploy-prod";

/**
 * The handoff between the request that asked for a deploy and the job that runs it.
 *
 * A deploy needs three things the HTTP request has and a job does not: what to
 * deploy (a git URL, or a tarball of the user's folder), who for, and the app's
 * own secrets. This module parks all three somewhere durable, hands back an id,
 * and lets the job pick them up — so the request can return the moment the work
 * is safely recorded instead of staying open for the whole build.
 *
 * Where each part goes is a deliberate split. The request — including the app's
 * secrets — goes into Postgres, which is private to the platform and from which
 * the row is DELETED as soon as the run ends, so a secret's window is one build
 * long. The source tarball is too big for that and goes to the assets bucket,
 * encrypted under a per-run key that only exists in that Postgres row. The
 * bucket is readable by the shared app runtime identity, so unencrypted source
 * sitting there would be readable by every other customer's container — the same
 * reasoning that already governs the prebuilt code bundles.
 */

let ensured: Promise<void> | null = null;
function ensure(): Promise<void> {
  if (!ensured) {
    ensured = getPool(DB).query(
      `CREATE TABLE IF NOT EXISTS deploy_runs (
         run_id        text PRIMARY KEY,
         slug          text        NOT NULL,
         request       jsonb       NOT NULL,
         source_object text,
         source_key    text,
         created_at    timestamptz NOT NULL DEFAULT now()
       )`
    ).then(() => undefined).catch((e) => { ensured = null; throw e; });
  }
  return ensured;
}

/** Everything runDeploy needs except the source bytes, which travel separately. */
export interface DeployRunRequest {
  ownerId: string;
  ownerWorkspace: string | null;
  slug: string;
  friendlyName: string;
  repoUrl: string;
  /**
   * The GitHub installation `repoUrl` is reachable through, or null.
   *
   * An id travels here; a token never could. This row is written now and read
   * by a job that may start minutes later, and an installation token lives an
   * hour — so the job mints its own from this id rather than being handed one
   * that might already be spent.
   */
  ghInstallationId: number | null;
  /**
   * The commit this build is OF, when a push caused it. Null everywhere else.
   *
   * Pinned here rather than resolved when the builder starts, and the reason is
   * measured: `app/api/deploy/route.ts` records 79 to 227 seconds between a
   * deploy being recorded and the builder's first line. On a repository
   * somebody is pushing to, HEAD moves inside that window — so cloning HEAD
   * would build code the platform was never told about and then report the
   * outcome on the wrong commit.
   *
   * A SHA travels here for the same reason an installation id does and a token
   * does not: it is a fact, not a credential, and it is still true when a job
   * claims this row minutes later.
   */
  commitSha: string | null;
  /**
   * The repository binding to write once this app's row exists, or null.
   *
   * Set only by the GitHub door, and only on the deploy that CONNECTS — every
   * later build of the app finds the link already in `app_repos`. It travels
   * here because the link cannot be written before `createAppRecord`, and that
   * runs inside the pipeline rather than in the route.
   */
  connect: RepoLink | null;
  isUpload: boolean;
  isPrebuilt: boolean;
  prebuiltHash: string;
  secrets: Record<string, string>;
  cloneToken: unknown;
  runCmd: string;
  limits: unknown;
}

function gcloud(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("gcloud", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(err.trim() || `gcloud exited ${c}`))));
  });
}

/** The same spawn, for the one call whose STDOUT is the answer. */
function gcloudOut(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("gcloud", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.stderr.on("data", (d: Buffer) => (err += d));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(err.trim() || `gcloud exited ${c}`))));
  });
}

/**
 * Which identity this process is. Its own copy rather than an import: the only
 * other one lives in lib/deploy-pipeline.ts, which pulls in the whole pipeline,
 * and this module is imported BY the route that dispatches to it.
 */
async function controlPlaneSA(): Promise<string | null> {
  try {
    const r = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email", {
      headers: { "Metadata-Flavor": "Google" },
    });
    return r.ok ? (await r.text()).trim() : null;
  } catch { return null; }
}

/**
 * Where the assets bucket lives, stated rather than looked up.
 *
 * `gcloud storage sign-url` auto-detects the bucket's region with
 * `storage.buckets.get`, and the control-plane SA does not hold it — the call
 * fails with "Failed to auto-detect the region" before it ever signs anything.
 * Passing the region explicitly skips that lookup, so signing needs no bucket
 * permission at all, only Token Creator on itself.
 */
const SIGN_REGION = "us-central1";

/** How long a source-upload URL is good for. One upload, on a home connection. */
const UPLOAD_URL_TTL = "30m";

/**
 * Mint a one-object signed PUT URL for a deploy's source.
 *
 * This exists because the tarball cannot come through this service. Cloud Run
 * caps a buffered request body at 32 MiB and the cap is enforced by the Google
 * front end, so the request is rejected before any code here runs: nothing is
 * logged, no handler sees it, and the only symptom is a deploy that stays
 * `reserved` forever. Measured on excalidraw, whose bundle is 36.3 MB.
 *
 * The bytes were always going to this bucket — `createRun` uploaded them one hop
 * later — so this moves the upload to the client rather than adding a store. The
 * client encrypts before sending, under a key it generates and hands back with
 * the deploy request, which keeps the property the bucket relies on: the shared
 * app runtime identity can read this bucket, so plaintext source sitting in it
 * would be readable by every other customer's container.
 *
 * Returns null if signing is unavailable, and the caller must then refuse rather
 * than fall back to the body — the body is exactly what does not work.
 */
export async function signedSourceUpload(): Promise<{ object: string; uploadUrl: string } | null> {
  const object = objectFor(randomUUID());
  try {
    const sa = await controlPlaneSA();
    const args = [
      "storage", "sign-url", `gs://${ASSETS_BUCKET}/${object}`,
      "--http-verb=PUT", `--duration=${UPLOAD_URL_TTL}`, `--region=${SIGN_REGION}`,
      "--project", PROJECT, "--format=json",
    ];
    if (sa) args.push(`--impersonate-service-account=${sa}`);
    const out = await gcloudOut(args);
    const start = out.indexOf("[");
    const arr = start >= 0 ? JSON.parse(out.slice(start)) : null;
    const o = Array.isArray(arr) ? arr[0] : arr;
    const url = o?.signed_url || o?.signedUrl || o?.url;
    return typeof url === "string" && url ? { object, uploadUrl: url } : null;
  } catch {
    return null;
  }
}

/**
 * Source that the client already put in the bucket, encrypted, itself.
 *
 * The key travels in the deploy request and lands in the same Postgres column a
 * server-side upload would have written, so everything downstream — `claimRun`,
 * the decrypt, the delete — cannot tell the two paths apart.
 */
export interface UploadedSource {
  object: string;
  key: string;
}

/** Does this object name look like one of ours, rather than a path chosen by the caller? */
export function isOwnSourceObject(object: string): boolean {
  return /^runs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tgz\.enc$/.test(object);
}

/**
 * Pull a client-uploaded source back down and decrypt it.
 *
 * Only the in-process deploy path needs this — with `DEPLOY_JOB=1` the job does
 * its own fetch through `claimRun`. It exists so that running the pipeline
 * inline, which is what a local control plane does, is not silently a deploy
 * with no source at all.
 */
export async function readUploadedSource(uploaded: UploadedSource): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "ss-run-"));
  try {
    const file = join(dir, "source.enc");
    await gcloud(["storage", "cp", `gs://${ASSETS_BUCKET}/${uploaded.object}`, file, "--project", PROJECT]);
    return decrypt(readFileSync(file), uploaded.key);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A passphrase rather than a raw key, so the stored secret is a printable string
// that survives JSON and a psql session unmangled. Fixed salt: the passphrase is
// already 32 random bytes and used exactly once, so a salt adds nothing here
// except a second value to keep alongside it.
const KEY_SALT = "supersonic-deploy-run";
const keyFor = (pass: string) => scryptSync(pass, KEY_SALT, 32);

function encrypt(buf: Buffer, pass: string): Buffer {
  const iv = randomBytes(16);
  const c = createCipheriv("aes-256-cbc", keyFor(pass), iv);
  return Buffer.concat([iv, c.update(buf), c.final()]);
}

function decrypt(buf: Buffer, pass: string): Buffer {
  const iv = buf.subarray(0, 16);
  const d = createDecipheriv("aes-256-cbc", keyFor(pass), iv);
  return Buffer.concat([d.update(buf.subarray(16)), d.final()]);
}

const objectFor = (runId: string) => `runs/${runId}.tgz.enc`;

/**
 * Record a deploy so a job can run it. Returns the id the job will be given.
 *
 * Throws if anything fails to persist — deliberately. A run that is only half
 * recorded is a deploy that will start and then not find its own source, which
 * is a far worse failure than refusing the request outright.
 */
export async function createRun(
  request: DeployRunRequest,
  archive: Buffer | null,
  uploaded: UploadedSource | null = null,
  // Minted by the caller when it needs the id BEFORE this returns — the route
  // stamps its first stage with it, and that stage starts before the run row
  // exists. Absent, one is generated here exactly as it always was.
  withId?: string,
): Promise<string> {
  await ensure();
  // Supersede whatever was already deploying this app.
  //
  // A deploy outlives the client that started it, by design — so hitting Ctrl-C
  // and running `supersonic deploy` again leaves TWO jobs building the same app,
  // racing to deploy the same Cloud Run service and to write the same row. I did
  // exactly that during testing and ended up with three. The newest request is
  // the one the user means; the older ones are abandoned work.
  await supersedeRunsFor(request.slug).catch(() => { /* never block a deploy on cleanup */ });
  const runId = withId || randomUUID();
  let sourceObject: string | null = null;
  let sourceKey: string | null = null;

  if (uploaded) {
    // Already in the bucket, already encrypted, by the client. Recorded exactly
    // as a server-side upload would have recorded it — `claimRun` reads these two
    // columns and has no idea which path filled them.
    sourceObject = uploaded.object;
    sourceKey = uploaded.key;
  } else if (archive) {
    sourceKey = randomBytes(32).toString("hex");
    sourceObject = objectFor(runId);
    const dir = mkdtempSync(join(tmpdir(), "ss-run-"));
    try {
      const file = join(dir, "source.enc");
      writeFileSync(file, encrypt(archive, sourceKey));
      await gcloud(["storage", "cp", file, `gs://${ASSETS_BUCKET}/${sourceObject}`, "--project", PROJECT]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  await getPool(DB).query(
    `INSERT INTO deploy_runs(run_id, slug, request, source_object, source_key)
       VALUES($1,$2,$3::jsonb,$4,$5)`,
    [runId, request.slug, JSON.stringify(request), sourceObject, sourceKey],
  );
  return runId;
}

/** Pick up a recorded run: its request and, if it had one, its source bytes. */
export async function claimRun(runId: string): Promise<{ request: DeployRunRequest; archive: Buffer | null; createdAt: Date | null } | null> {
  await ensure();
  // created_at comes back so the job can measure what it cost to get here. The
  // wait between a job being accepted and a job running is the darkest part of
  // the deploy budget and the only clock that spans it is this column.
  const r = await getPool(DB).query(
    `SELECT request, source_object, source_key, created_at FROM deploy_runs WHERE run_id = $1`, [runId],
  );
  const row = r.rows[0];
  if (!row) return null;

  let archive: Buffer | null = null;
  if (row.source_object && row.source_key) {
    const dir = mkdtempSync(join(tmpdir(), "ss-run-"));
    try {
      const file = join(dir, "source.enc");
      await gcloud(["storage", "cp", `gs://${ASSETS_BUCKET}/${row.source_object}`, file, "--project", PROJECT]);
      archive = decrypt(readFileSync(file), row.source_key);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return {
    request: row.request as DeployRunRequest,
    archive,
    createdAt: row.created_at ? new Date(row.created_at) : null,
  };
}

/**
 * Stop anything already deploying this slug, so a new deploy supersedes it.
 *
 * Cancelling the execution is what actually stops the work; deleting the row is
 * what stops it being found again. Both are best-effort: a stale job that cannot
 * be cancelled is much less bad than refusing the deploy somebody just asked for.
 */
export async function supersedeRunsFor(slug: string): Promise<void> {
  const ids = await runIdsForSlug(slug);
  if (!ids.length) return;
  for (const id of ids) await finishRun(id).catch(() => {});
  // Both places a deploy can be running. Cancelling only the Job would have
  // made this function quietly half-effective the moment the worker started
  // taking deploys — superseding would delete the row and leave the previous
  // deploy running, which is the exact race the cancel exists to close.
  await Promise.all([
    cancelExecutionsFor(ids).catch(() => {}),
    cancelOnWorker(ids).catch(() => {}),
  ]);
}

/** Stop a superseded run if the warm worker is the one running it. */
async function cancelOnWorker(runIds: string[]): Promise<void> {
  const url = workerUrl();
  if (!url) return;
  const token = await identityToken(url);
  if (!token) return;
  await fetch(`${url}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ runIds }),
    signal: AbortSignal.timeout(WORKER_ACCEPT_MS),
  });
}

/** Cancel the job executions carrying any of these run ids. */
async function cancelExecutionsFor(runIds: string[]): Promise<void> {
  const job = process.env.DEPLOY_JOB_NAME || "supersonic-deploy-job";
  const region = "us-central1";
  const out = await new Promise<string>((resolve) => {
    const p = spawn("gcloud", ["run", "jobs", "executions", "list", "--job", job,
      "--region", region, "--project", PROJECT,
      "--filter", "status.runningCount>0", "--format=value(metadata.name)"], { stdio: ["ignore", "pipe", "ignore"] });
    let o = ""; p.stdout.on("data", (d: Buffer) => (o += d));
    p.on("error", () => resolve("")); p.on("close", () => resolve(o));
  });
  for (const name of out.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const args = await new Promise<string>((resolve) => {
      const p = spawn("gcloud", ["run", "jobs", "executions", "describe", name, "--region", region,
        "--project", PROJECT, "--format=value(spec.template.spec.containers[0].args)"], { stdio: ["ignore", "pipe", "ignore"] });
      let o = ""; p.stdout.on("data", (d: Buffer) => (o += d));
      p.on("error", () => resolve("")); p.on("close", () => resolve(o));
    });
    if (!runIds.some((id) => args.includes(id))) continue;
    await gcloud(["run", "jobs", "executions", "cancel", name, "--region", region, "--project", PROJECT, "--quiet"]).catch(() => {});
  }
}

/** The run ids recorded for an app, so its in-flight deploys can be found and stopped. */
export async function runIdsForSlug(slug: string): Promise<string[]> {
  try {
    await ensure();
    const r = await getPool(DB).query(`SELECT run_id FROM deploy_runs WHERE slug = $1`, [slug]);
    return r.rows.map((row: { run_id: string }) => row.run_id);
  } catch {
    return [];
  }
}

/**
 * Forget a finished run.
 *
 * This is what bounds how long the app's secrets sit in the database, so it runs
 * whatever the deploy did — the row is of no use to anyone once the job has read
 * it, and a failed deploy is not a reason to keep a copy of someone's .env.
 */
export async function finishRun(runId: string): Promise<void> {
  try {
    await ensure();
    const r = await getPool(DB).query(
      `DELETE FROM deploy_runs WHERE run_id = $1 RETURNING source_object`, [runId],
    );
    const object = r.rows[0]?.source_object;
    if (object) {
      await gcloud(["storage", "rm", `gs://${ASSETS_BUCKET}/${object}`, "--project", PROJECT]).catch(() => {});
    }
  } catch { /* a leftover row is swept below; never fail a finished deploy over it */ }
}

/**
 * Drop runs nobody claimed.
 *
 * A job execution that never started (quota, a bad rollout) leaves its row and
 * its source behind, and those rows hold secrets. Swept on the way in to a new
 * run rather than on a schedule, for the same reason as the event prune.
 */
export async function pruneRuns(hours = 6): Promise<void> {
  try {
    await ensure();
    const r = await getPool(DB).query(
      `DELETE FROM deploy_runs WHERE created_at < now() - ($1 || ' hours')::interval RETURNING source_object`,
      [String(hours)],
    );
    for (const row of r.rows) {
      if (row.source_object) {
        await gcloud(["storage", "rm", `gs://${ASSETS_BUCKET}/${row.source_object}`, "--project", PROJECT]).catch(() => {});
      }
    }
  } catch { /* ignore */ }
}

/**
 * How the job is invoked, minus the run id.
 *
 * Kept here rather than only in the job's own definition because `--args` on an
 * execution REPLACES the job's arguments — it does not append to them. Passing
 * just the run id would leave `node <uuid>`, which fails instantly and for a
 * reason nobody would guess from the message. scripts/setup-deploy-job.sh
 * creates the job with this same list.
 */
const DEPLOY_JOB_ARGS = ["--import", "tsx", "scripts/deploy-job.ts"];

/**
 * Where the two images come from. Injected so the check can be tested without
 * reaching Cloud Run.
 */
export interface ImageProbe {
  jobImage: () => Promise<string>;
  serviceImage: () => Promise<string>;
}

async function fetchImage(url: string, pick: (body: any) => string | undefined): Promise<string> {
  const token = await accessToken();
  if (!token) throw new Error("no access token");
  // gcp-rest.ts's own calls go through its `authed()`, which sets this same
  // timeout — but `authed` collapses every failure, including a timeout, to
  // `null` rather than throwing, and is not exported. This function's contract
  // is the opposite: throw, so assertJobImageMatches's catch fails the check
  // open. Reusing `authed` would mean turning its `null` back into a throw
  // anyway while losing the underlying error's message, so this keeps its own
  // fetch and takes only the constant. Without a timeout, this runs on the
  // deploy dispatch path ahead of undici's 300s default — the guard fails open
  // on an ERROR, but a HANG would stall a customer's deploy for minutes first.
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  // A 200 whose body does not have the shape expected — a Cloud Run API
  // change, say — is a probe that cannot answer, not evidence of an untagged
  // image. Throwing here, rather than coercing to "", sends it into
  // assertJobImageMatches's catch, which fails the check open instead of
  // refusing the deploy on a comparison neither side actually made.
  const image = pick(await res.json());
  // Not just `!image`: `pick` reads a deeply-nested field out of JSON this code
  // does not control, and a schema change can make that field an object or a
  // number rather than absent. `!image` is false for either, and the caller
  // hands the result straight to `imageTag`, which assumes a string and throws
  // — outside this function's try, so it would escape assertJobImageMatches's
  // catch and turn a schema change into a 503 on every deploy instead of a
  // fail-open.
  if (typeof image !== "string" || !image) throw new Error(`${url} answered 200 with no container image`);
  return image;
}

/**
 * A function of `job` and `region` rather than constants: `jobImage` has to ask
 * about the same job, in the same region, that `assertJobImageMatches` was
 * asked about, not re-derive either from the environment. Both call sites pass
 * the same values either way today, so `region` defaulting to gcp-rest.ts's own
 * constant was silent — but a job running in a different region from this
 * service would have been compared against the wrong URL with nothing to say
 * so, the same failure shape `job` re-deriving from `DEPLOY_JOB_NAME` would
 * have been.
 */
function liveProbe(job: string, region: string): ImageProbe {
  return {
    jobImage: () => fetchImage(
      runJobUrl(job, undefined, region),
      (b) => b?.template?.template?.containers?.[0]?.image),
    serviceImage: () => fetchImage(
      runServiceUrl(process.env.K_SERVICE || "supersonic-control-plane", undefined, region),
      (b) => b?.spec?.template?.spec?.containers?.[0]?.image),
  };
}

/**
 * Refuse to hand a deploy to a job running different code from this service.
 *
 * `scripts/deploy-job.ts` states the guarantee this replaces: "the job and the
 * API are the same image, so they can never drift." Nothing enforced it.
 * `cloudbuild.yaml`'s job step used to update the job unconditionally with
 * `|| echo`, so a failed update never failed the build — the job kept the
 * previous commit's pipeline while the service moved, and every deploy ran
 * code nobody believed was running. That is the worst kind of drift, because
 * the thing that looks deployed is not the thing doing the work.
 *
 * The build now fails on a real update failure too (the job step there tells
 * a missing job apart from a broken one), which closes off the common case.
 * This guard is the belt to that suspenders: it catches a job stuck on a
 * stale image for any OTHER reason — a stalled rollout, a hand edit, a bug in
 * that very branch — by asking the job and the service directly rather than
 * trusting that the step which was supposed to update the job actually did.
 *
 * A probe that cannot answer does NOT block the deploy. The check exists to
 * catch a stale image, not to become a fresh way for every deploy to fail when
 * an API is having a bad minute.
 */
export async function assertJobImageMatches(job: string, region: string, deps: ImageProbe = liveProbe(job, region)): Promise<void> {
  // The switch-off, in the shape BUILDER and the other lane flags already use —
  // except looser about how "on" is spelled. Those are set once in
  // cloudbuild.yaml and left alone; this one is reached for BY HAND, mid-incident,
  // by someone who does not have this file open. Exact-match "1" means the
  // obvious "true"/"yes" silently does nothing, and the minutes lost to that
  // are exactly the minutes this lever exists to save.
  if (/^(1|true|yes)$/i.test(process.env.SKIP_JOB_IMAGE_CHECK ?? "")) return;
  let jobRef: string, serviceRef: string;
  try {
    [jobRef, serviceRef] = await Promise.all([deps.jobImage(), deps.serviceImage()]);
  } catch (e) {
    console.error(`could not compare ${job}'s image against this service's`, e);
    return;
  }
  const a = imageTag(jobRef), b = imageTag(serviceRef);
  if (!a || !b) {
    throw new Error(`refusing to deploy: an untagged image (job "${jobRef}", service "${serviceRef}") cannot be compared`);
  }
  if (a !== b) {
    throw new Error(`refusing to deploy: ${job} runs image tag ${a} but this service runs ${b} — the job was not updated by the last deploy of main`);
  }
}

/**
 * Start the job that will run this deploy.
 *
 * The run id goes in as an argument, not an environment variable: an env-var
 * override is applied to the execution, but arguments keep the whole invocation
 * in one place and visible in the execution record, which is where anyone
 * debugging a lost deploy will look first.
 */
export async function startDeployJob(runId: string, region: string, job: string): Promise<void> {
  await assertJobImageMatches(job, region);
  return gcloud([
    "run", "jobs", "execute", job,
    "--region", region, "--project", PROJECT,
    // `--args=…`, one token. Passed as two, gcloud reads the value's leading
    // `--import` as a flag of its own and refuses with "expected one argument".
    `--args=${[...DEPLOY_JOB_ARGS, runId].join(",")}`,
    // Return as soon as the execution is accepted. Waiting for it would put the
    // build back on the request's clock, which is the entire thing being fixed.
    "--async", "--quiet",
  ]);
}

/**
 * Where the warm worker is, and the commit this service is running.
 *
 * Unset means there is no worker — every deploy takes the Job, which is what
 * happened before this existed and what happens in any environment that has
 * not been given one. That is the switch-off: clear DEPLOY_WORKER_URL on the
 * service and the next deploy is dispatched the old way, with no code change
 * and nothing to roll back.
 */
function workerUrl(): string {
  return (process.env.DEPLOY_WORKER_URL || "").trim().replace(/\/+$/, "");
}
function imageTagOfThisService(): string {
  return (process.env.IMAGE_TAG || "").trim();
}

/**
 * How long to wait for the worker to say yes.
 *
 * This is on the deploy path — a person is watching — and the whole reason the
 * worker exists is to make this hop small. A warm worker answers in
 * milliseconds; anything approaching this bound means it is not answering, and
 * the Job is a better answer than a longer wait. Deliberately far below
 * HTTP_TIMEOUT_MS (20s), which is sized for Google APIs rather than for one
 * hop to a service that is by construction already running.
 */
const WORKER_ACCEPT_MS = 4_000;

/** What the worker said when asked to take a run. */
type WorkerVerdict = "accepted" | "declined";

/**
 * Offer a run to the warm worker.
 *
 * Every failure is "declined", and that is the design rather than laziness:
 * the Job path is still there, still correct, and still the thing that ran
 * every deploy until now. There is no failure of this call that is better
 * handled by failing the customer's deploy than by taking 104 seconds longer.
 * The one thing it must not do is claim a deploy started when it did not, so
 * only an explicit 202 counts.
 */
export async function offerToWorker(runId: string): Promise<WorkerVerdict> {
  const url = workerUrl();
  if (!url) return "declined";
  try {
    // The worker is deployed without public access, so this is an IAM call and
    // needs an identity token for the worker's own url as audience — the same
    // mechanism, and the same helper, that reaching a sealed app uses.
    const token = await identityToken(url);
    if (!token) return "declined";
    const res = await fetch(`${url}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ runId, imageTag: imageTagOfThisService() }),
      signal: AbortSignal.timeout(WORKER_ACCEPT_MS),
    });
    if (res.status === 202) return "accepted";
    // 429 (already deploying) and 409 (running a different commit) are the two
    // designed refusals and are normal. Logged all the same: a worker that
    // refuses EVERY deploy looks exactly like a worker that is not configured,
    // and the difference should not need a debugger to find.
    console.error(`deploy worker declined ${runId}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return "declined";
  } catch (e) {
    console.error(`deploy worker could not be reached for ${runId}`, e);
    return "declined";
  }
}

/**
 * Start the deploy — on the warm worker if it will take it, on the Job if not.
 *
 * The Job costs 104s p50 before the pipeline's first line (114 executions), and
 * `job-launch` says 116s of that is Cloud Run's own scheduling and container
 * start rather than anything this repository controls: a hello-world image took
 * 54-103s to first log in the same project. The worker is already running, so
 * that entire span becomes one HTTP hop.
 *
 * ORDER MATTERS AND SO DOES THE FALLBACK. The worker takes one deploy at a
 * time and refuses the second, so a busy minute still deploys — it just pays
 * the old price for the overflow. Nothing here can leave a run undispatched:
 * every path that is not an accepted 202 goes to the Job, and a Job that
 * cannot start throws, which the route already turns into an honest 503 and a
 * deleted run row.
 */
export interface DispatchDeps {
  offer: (runId: string) => Promise<WorkerVerdict>;
  toJob: (runId: string, region: string, job: string) => Promise<void>;
}

export async function startDeployRun(
  runId: string,
  region: string,
  job: string,
  deps: DispatchDeps = { offer: offerToWorker, toJob: startDeployJob },
): Promise<void> {
  if (await deps.offer(runId) === "accepted") return;
  await deps.toJob(runId, region, job);
}

/**
 * How many deploys this owner already has in flight.
 *
 * Counted from `deploy_runs`, whose rows exist for exactly the window that
 * matters: `createRun` writes one and `finishRun` deletes it once the job has
 * read it. No migration — `request` is jsonb and already carries `ownerId`, and
 * the no-new-schema rule is in force until deploys work.
 *
 * WHY THERE HAS TO BE A CAP AT ALL
 *
 * Build-seconds per deploy went up 3-6x when every app started building an image,
 * and up to 24x on a deploy the repair agent retries. Nothing throttles: `LIMITS`
 * gates how many apps an owner may HAVE, never how many may be building at once,
 * dispatch is fire-and-forget `--async`, and every deploy also holds a Cloud Run
 * Job task at 4Gi/2cpu for the whole build. No private pool is configured, so
 * this lands on the shared default pool and its per-project concurrent-build
 * quota — and a queued build is indistinguishable from a slow app in the CLI.
 *
 * BOUNDED BY TIME, deliberately. A run whose job died without calling
 * `finishRun` would otherwise count against its owner until `pruneRuns` catches
 * it six hours later, and "you have too many deploys running" about deploys that
 * are not running is worse than no cap. One hour is past `BUILD_TIMEOUT` (1200s)
 * and past any real deploy, so a row older than that is wreckage rather than work.
 */
export async function inFlightForOwner(ownerId: string): Promise<number> {
  if (!ownerId) return 0;
  try {
    await ensure();
    const r = await getPool(DB).query(
      `SELECT count(*)::int AS n FROM deploy_runs
        WHERE request->>'ownerId' = $1 AND created_at > now() - interval '1 hour'`,
      [ownerId],
    );
    return r.rows[0]?.n ?? 0;
  } catch {
    // The cap is a courtesy, not a correctness property. A database that cannot
    // answer must not be the reason somebody cannot deploy.
    return 0;
  }
}
