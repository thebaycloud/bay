import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPool } from "./db";
import { ASSETS_BUCKET } from "./static-release";

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
export async function createRun(request: DeployRunRequest, archive: Buffer | null): Promise<string> {
  await ensure();
  // Supersede whatever was already deploying this app.
  //
  // A deploy outlives the client that started it, by design — so hitting Ctrl-C
  // and running `supersonic deploy` again leaves TWO jobs building the same app,
  // racing to deploy the same Cloud Run service and to write the same row. I did
  // exactly that during testing and ended up with three. The newest request is
  // the one the user means; the older ones are abandoned work.
  await supersedeRunsFor(request.slug).catch(() => { /* never block a deploy on cleanup */ });
  const runId = randomUUID();
  let sourceObject: string | null = null;
  let sourceKey: string | null = null;

  if (archive) {
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
export async function claimRun(runId: string): Promise<{ request: DeployRunRequest; archive: Buffer | null } | null> {
  await ensure();
  const r = await getPool(DB).query(
    `SELECT request, source_object, source_key FROM deploy_runs WHERE run_id = $1`, [runId],
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
  return { request: row.request as DeployRunRequest, archive };
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
  await cancelExecutionsFor(ids).catch(() => {});
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
export const DEPLOY_JOB_ARGS = ["--import", "tsx", "scripts/deploy-job.ts"];

/**
 * Start the job that will run this deploy.
 *
 * The run id goes in as an argument, not an environment variable: an env-var
 * override is applied to the execution, but arguments keep the whole invocation
 * in one place and visible in the execution record, which is where anyone
 * debugging a lost deploy will look first.
 */
export function startDeployJob(runId: string, region: string, job: string): Promise<void> {
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
