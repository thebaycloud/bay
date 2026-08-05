import { spawn } from "node:child_process";

const PROJECT = "supersonic-deploy-prod";

/**
 * The app's own secrets, in Secret Manager rather than in a Cloud Run spec.
 *
 * Two problems, one cause. The values used to be passed as `--update-env-vars`,
 * which writes them verbatim into the revision spec — readable by anyone with
 * console or `run services describe` access, printed in deploy diffs, and
 * retained in every past revision forever. That is the wrong home for a Stripe
 * key.
 *
 * And it left them unavailable exactly where a build needs them. The prepare step
 * runs in Cloud Build with only the SUPERSONIC_* plumbing, so an app whose BUILD
 * reads its environment could not deploy at all: Prisma 7 loads
 * `prisma.config.js` on every CLI command, `env('DATABASE_URL')` throws when
 * unset, and `prisma generate` died — while the log one line earlier said
 * "Injecting DATABASE_URL". The platform had provisioned a database the build
 * could not see.
 *
 * Secret Manager solves both: Cloud Run mounts them with `--set-secrets`, Cloud
 * Build reads the same versions through `availableSecrets`, and neither copy
 * lives in a spec.
 */

function gcloud(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("gcloud", args, { env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: "1" } });
    let out = "", err = "";
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.stderr.on("data", (d: Buffer) => (err += d));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(err.trim() || `gcloud exited ${c}`))));
  });
}

function gcloudIn(args: string[], stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("gcloud", args, { env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: "1" } });
    let out = "", err = "";
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.stderr.on("data", (d: Buffer) => (err += d));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(err.trim() || `gcloud exited ${c}`))));
    p.stdin.on("error", reject);
    p.stdin.end(stdin);
  });
}

/**
 * One secret per app per variable.
 *
 * Per-variable rather than one blob, because that is the shape both consumers
 * want: `--set-secrets KEY=name:latest` on Cloud Run and one `secretEnv` entry
 * per variable in Cloud Build both map a single secret to a single variable. A
 * blob would have to be unpacked by something at runtime, which puts the values
 * back into a process environment we control less carefully.
 */
export function secretName(slug: string, key: string): string {
  return `app-${slug}-${key}`;
}

/** Secret Manager ids are [A-Za-z0-9_-]; env var names are already a subset. */
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SecretRef { key: string; name: string }

/**
 * Store (or update) the app's secrets and grant the runtime identity access.
 *
 * Best-effort per variable: one key that cannot be stored must not take down a
 * deploy that would otherwise work, so failures are reported and skipped rather
 * than thrown. The caller falls back to a plain env var for anything skipped,
 * which is exactly the old behaviour and no worse.
 */
export async function putAppSecrets(
  slug: string,
  vars: Record<string, string>,
  runtimeServiceAccount: string,
  log: (l: string) => void,
): Promise<{ stored: SecretRef[]; skipped: string[] }> {
  const stored: SecretRef[] = [];
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(vars)) {
    if (!VALID_KEY.test(key)) { skipped.push(key); continue; }
    const name = secretName(slug, key);
    try {
      // Create-or-add-version. `describe` first so an existing secret gets a new
      // version rather than an error, and so the IAM grant is only applied once.
      let existed = true;
      try {
        await gcloud(["secrets", "describe", name, "--project", PROJECT]);
      } catch {
        existed = false;
        await gcloudIn(["secrets", "create", name, "--data-file=-", "--replication-policy=automatic", "--project", PROJECT], value);
      }
      if (existed) {
        await gcloudIn(["secrets", "versions", "add", name, "--data-file=-", "--project", PROJECT], value);
      } else if (runtimeServiceAccount) {
        await gcloud(["secrets", "add-iam-policy-binding", name,
          "--member", `serviceAccount:${runtimeServiceAccount}`,
          "--role", "roles/secretmanager.secretAccessor", "--project", PROJECT]);
      }
      stored.push({ key, name });
    } catch (e) {
      // Named, not silent: a value that did not make it to Secret Manager is
      // about to be set as a plain env var instead, and that is worth saying.
      log(`could not store ${key} in Secret Manager (${e instanceof Error ? e.message.split("\n")[0] : String(e)}) — setting it directly`);
      skipped.push(key);
    }
  }
  return { stored, skipped };
}

/**
 * Read a secret this platform stored, or null when there is none.
 *
 * Needed because some platform-owned values must survive a redeploy rather than
 * be minted fresh each time: an app's database password is the same password its
 * Postgres role already has, and regenerating it every deploy would lock out the
 * revision still serving traffic.
 */
export async function readAppSecret(slug: string, key: string): Promise<string | null> {
  try {
    return (await gcloud(["secrets", "versions", "access", "latest", "--secret", secretName(slug, key), "--project", PROJECT])).trim();
  } catch {
    return null;
  }
}

/** `--set-secrets` value: `KEY=secret-name:latest,…` */
export function setSecretsFlag(refs: SecretRef[]): string {
  return refs.map((r) => `${r.key}=${r.name}:latest`).join(",");
}

/**
 * Grant one identity read access to a set of secrets, one binding per secret.
 *
 * Per-secret rather than a project-wide role: Cloud Build runs customer install
 * steps, so what it may read is exactly the app it is building and nothing else.
 *
 * The fleet NODES are deliberately NOT granted this way — their service account
 * holds the role project-wide. See the note at the `allAppSecrets` call in
 * `runFleetDeploy` for why that was widened, and what it costs.
 *
 * Best-effort per secret. `add-iam-policy-binding` is a read-modify-write against
 * an etag, so two deploys of the same app can collide on one binding while every
 * other binding lands — failing the deploy for that would be worse than the thing
 * it prevents, and the consumer's own error names the secret it could not read.
 * Silent, though, it must never be: an unheard grant failure is exactly how a
 * 403 arrives later with nothing in the log pointing at its cause.
 */
async function grantSecretAccess(
  refs: SecretRef[],
  serviceAccount: string,
  who: string,
  log: (l: string) => void,
): Promise<void> {
  if (!serviceAccount) return;
  for (const r of refs) {
    try {
      await gcloud(["secrets", "add-iam-policy-binding", r.name,
        "--member", `serviceAccount:${serviceAccount}`,
        "--role", "roles/secretmanager.secretAccessor", "--project", PROJECT]);
    } catch (e) {
      log(`${who} cannot read ${r.key} (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`);
    }
  }
}

/** Grant the Cloud Build service account read access, so the prepare step can use them. */
export async function grantBuildAccess(refs: SecretRef[], buildServiceAccount: string, log: (l: string) => void): Promise<void> {
  return grantSecretAccess(refs, buildServiceAccount, "build", log);
}


/** Forget every secret belonging to an app. Called from the delete path. */
export async function deleteAppSecrets(slug: string): Promise<void> {
  try {
    const out = await gcloud(["secrets", "list", "--project", PROJECT,
      "--filter", `name~^projects/.*/secrets/app-${slug}-`, "--format=value(name)"]);
    for (const name of out.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const id = name.split("/").pop()!;
      await gcloud(["secrets", "delete", id, "--project", PROJECT, "--quiet"]).catch(() => {});
    }
  } catch { /* nothing stored, or listing failed — the app is going away regardless */ }
}

/**
 * Every secret this app has, not only the ones this deploy just stored.
 *
 * The distinction is invisible on the service path and decisive on the process
 * path, which is how it reached production. `--update-secrets` MERGES, so a
 * redeploy that re-sends nothing leaves the previous revision's mounts in place
 * and the app keeps its keys. Worker pools and jobs are deployed with
 * `--set-secrets` — desired state, on purpose, so a secret removed from the
 * config is gone from the next revision — and desired state means anything not
 * passed is dropped.
 *
 * `putAppSecrets` returns only what this deploy WROTE, and the CLI deliberately
 * does not re-send a value already set on the app ("vars already set are left
 * alone"). So on the second deploy of a Telegram bot the worker came up with
 * `SUPERSONIC_CODE_KEY` and nothing else, and died on
 * `KeyError: 'BOT_TOKEN'` — the app's own error, for a secret the platform was
 * holding the whole time.
 *
 * Listing is the fix rather than threading more state through the pipeline,
 * because Secret Manager is the actual source of truth for what the app has, and
 * anything derived from this deploy's inputs answers a narrower question than the
 * one being asked.
 *
 * Best-effort: a listing failure returns what the caller already had rather than
 * failing the deploy, and the app's own error then names the missing variable —
 * which is strictly better than a deploy that stops for a permission problem.
 */
export async function allAppSecrets(slug: string, thisDeploy: SecretRef[]): Promise<SecretRef[]> {
  const refs = new Map(thisDeploy.map((r) => [r.key, r]));
  try {
    const out = await gcloud(["secrets", "list", "--project", PROJECT,
      "--filter", `name~^projects/.*/secrets/app-${slug}-`, "--format=value(name)"]);
    for (const line of out.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const name = line.split("/").pop()!;
      const key = name.slice(`app-${slug}-`.length);
      // A key that does not round-trip is a secret this scheme did not create —
      // never guessed at, because mounting the wrong name onto a variable is
      // worse than leaving it unset.
      if (key && VALID_KEY.test(key) && secretName(slug, key) === name && !refs.has(key)) {
        refs.set(key, { key, name });
      }
    }
  } catch { /* keep what this deploy stored; the app names anything still missing */ }
  return [...refs.values()];
}
