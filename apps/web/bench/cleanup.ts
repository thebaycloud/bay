/**
 * Leave nothing behind, and prove it.
 *
 *   npm run bench:cleanup -- --batch aug09 --target prod
 *   npm run bench:cleanup -- --batch aug09 --target prod --audit-only
 *
 * The harness already deletes each app as it finishes, through the same endpoint
 * a user's "delete" button calls. This exists because that is not evidence.
 *
 * `lib/gcloud.ts` deleteApp is thorough now, but read its own comments: the
 * database drop "DOES NOT WORK for a provisioned database and never has, and the
 * catch is why nobody knew" — five orphaned databases found on 5 Aug; worker
 * pools that "nothing deleted, ever", leaving a container running and billing
 * with no row anywhere to explain it; Artifact Registry images that the
 * function's own docstring claimed to remove and never did. Every one of those
 * was invisible for months because the delete path swallows its failures on
 * purpose, and rightly so — a hiccup must not turn "delete my app" into a 500.
 *
 * So this does the opposite job. It asks GCP what still exists under the bench's
 * slugs, deletes what it finds, asks again, and FAILS LOUDLY on anything still
 * standing. A cleanup that reports success without looking is how the last set
 * of orphans happened.
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = "supersonic-deploy-prod";
const REGION = "us-central1";
const ASSETS_BUCKET = "supersonic-static-assets";
// Must match lib/gcloud.ts IMAGE_REPO — a wrong repo name here makes the audit
// find nothing and report clean, which is the one failure mode this tool exists
// to prevent.
const IMAGE_REPO = "cloud-run-source-deploy";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const auditOnly = process.argv.includes("--audit-only");

function gcloud(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn("gcloud", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", () => { /* a "not found" is an answer, not an error */ });
    p.on("error", () => resolve(""));
    p.on("close", () => resolve(out));
  });
}

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

/**
 * Every slug this batch created, read from the results it wrote.
 *
 * From the results file rather than from "apps owned by the bench user",
 * because the second one cannot see an app whose row was already deleted while
 * its Cloud Run service survived — which is exactly the failure being looked
 * for.
 */
function batchSlugs(batch: string, target: string): string[] {
  const dir = join(here, "results");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.startsWith(`${batch}-`) && (!target || f.includes(target)));
  const slugs = new Set<string>();
  for (const f of files) {
    for (const line of lines(readFileSync(join(dir, f), "utf8"))) {
      try { const r = JSON.parse(line); if (r.slug) slugs.add(r.slug as string); } catch { /* not a row */ }
    }
  }
  return [...slugs];
}

interface Leftover { kind: string; name: string; how: string[] }

/** Everything GCP still holds for these slugs. */
async function audit(slugs: string[]): Promise<Leftover[]> {
  if (!slugs.length) return [];
  const mine = (name: string) => slugs.some((s) => name === s || name.startsWith(`${s}-`) || name === `ss-exec-${s}`);
  const found: Leftover[] = [];

  const services = lines(await gcloud(["run", "services", "list", "--region", REGION, "--project", PROJECT, "--format=value(metadata.name)"]));
  for (const n of services.filter(mine)) {
    found.push({ kind: "cloud-run service", name: n, how: ["run", "services", "delete", n, "--region", REGION, "--project", PROJECT, "--quiet"] });
  }

  // The one that "nothing deleted, ever" — and the one that goes on billing
  // invisibly, because no list a person normally runs shows it.
  const pools = lines(await gcloud(["beta", "run", "worker-pools", "list", "--region", REGION, "--project", PROJECT, "--format=value(metadata.name)"]));
  for (const n of pools.filter(mine)) {
    found.push({ kind: "worker pool", name: n, how: ["beta", "run", "worker-pools", "delete", n, "--region", REGION, "--project", PROJECT, "--quiet"] });
  }

  const jobs = lines(await gcloud(["run", "jobs", "list", "--region", REGION, "--project", PROJECT, "--format=value(metadata.name)"]));
  for (const n of jobs.filter(mine)) {
    found.push({ kind: "cloud-run job", name: n, how: ["run", "jobs", "delete", n, "--region", REGION, "--project", PROJECT, "--quiet"] });
  }

  // The worst kind to leave: a cron whose app is gone keeps firing forever
  // against a URL that 404s, writing a failure into the logs every time.
  const sched = lines(await gcloud(["scheduler", "jobs", "list", "--location", REGION, "--project", PROJECT, "--format=value(name)"]))
    .map((l) => l.split("/").pop() ?? "");
  for (const n of sched.filter(mine)) {
    found.push({ kind: "scheduler job", name: n, how: ["scheduler", "jobs", "delete", n, "--location", REGION, "--project", PROJECT, "--quiet"] });
  }

  // Storage grows with DEPLOYS, not apps: every build pushes an image plus a
  // `mode=max` cache that by construction holds more layers than the image, and
  // every repair retry pushes another. Sixty deploys is sixty of those.
  const pkgs = lines(await gcloud(["artifacts", "packages", "list", "--repository", IMAGE_REPO, "--location", REGION, "--project", PROJECT, "--format=value(name)"]))
    .map((l) => l.split("/").pop() ?? "");
  for (const n of pkgs.filter(mine)) {
    found.push({ kind: "image package", name: n, how: ["artifacts", "packages", "delete", n, "--repository", IMAGE_REPO, "--location", REGION, "--project", PROJECT, "--quiet"] });
  }

  for (const slug of slugs) {
    const objects = lines(await gcloud(["storage", "ls", `gs://${ASSETS_BUCKET}/${slug}/**`]));
    if (objects.length) {
      found.push({ kind: "static release", name: `gs://${ASSETS_BUCKET}/${slug} (${objects.length} objects)`, how: ["storage", "rm", "-r", `gs://${ASSETS_BUCKET}/${slug}`, "--quiet"] });
    }
    const ready = lines(await gcloud(["storage", "ls", `gs://${ASSETS_BUCKET}/ready/${slug}/**`]));
    if (ready.length) {
      found.push({ kind: "runner bundle", name: `gs://${ASSETS_BUCKET}/ready/${slug}`, how: ["storage", "rm", "-r", `gs://${ASSETS_BUCKET}/ready/${slug}`, "--quiet"] });
    }
    const bucket = lines(await gcloud(["storage", "ls", `gs://supersonicdeploy-${slug}`]));
    if (bucket.length) {
      found.push({ kind: "per-app bucket", name: `gs://supersonicdeploy-${slug}`, how: ["storage", "rm", "-r", `gs://supersonicdeploy-${slug}`, "--quiet"] });
    }
  }

  // Databases. gcloud can list them even though it famously cannot drop the
  // provisioned ones — which is exactly why listing them here matters: this is
  // the check that would have caught the five orphans on 5 Aug.
  const dbs = lines(await gcloud(["sql", "databases", "list", "--instance", "supersonic-shared-pg", "--project", PROJECT, "--format=value(name)"]));
  for (const db of dbs) {
    if (slugs.some((s) => db === s.replace(/-/g, "_").slice(0, 60))) {
      found.push({ kind: "DATABASE", name: db, how: [] });  // cannot be dropped by gcloud — see lib/gcloud.ts
    }
  }

  return found;
}

async function main() {
  const batch = arg("batch");
  const target = arg("target") ?? "";
  if (!batch) { console.error("pass --batch <name>"); process.exit(2); }

  const slugs = batchSlugs(batch, target);
  if (!slugs.length) { console.error(`no slugs found for batch ${batch} — nothing this tool can verify`); process.exit(2); }
  console.log(`batch ${batch}: ${slugs.length} slugs — ${slugs.join(", ")}\n`);

  const before = await audit(slugs);
  if (!before.length) { console.log("nothing left behind. clean."); return; }

  console.log(`${before.length} leftovers:`);
  for (const l of before) console.log(`  ${l.kind.padEnd(18)} ${l.name}`);
  if (auditOnly) { console.log("\n--audit-only: nothing removed"); process.exit(1); }

  console.log("\nremoving…");
  for (const l of before) {
    if (!l.how.length) {
      console.log(`  SKIP ${l.kind} ${l.name} — gcloud cannot drop this; see lib/gcloud.ts dropAppDatabase`);
      continue;
    }
    await gcloud(l.how);
  }

  // Ask again. The whole point.
  const after = await audit(slugs);
  if (!after.length) { console.log("\nverified clean."); return; }
  console.error(`\n${after.length} STILL PRESENT after deletion:`);
  for (const l of after) console.error(`  ${l.kind.padEnd(18)} ${l.name}`);
  console.error("\nThese are billing or will be inherited by whoever gets the slug next.");
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
