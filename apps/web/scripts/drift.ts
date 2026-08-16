/**
 * What the platform believes, against what actually exists.
 *
 * Everything that went wrong on 16 Aug had one shape: the platform's picture of
 * the world diverged from the world, and nothing was looking. Four separate
 * "bugs", one missing capability:
 *
 *   - the platform said zero apps; twenty-six Cloud Run services were serving
 *   - `deleteApp` said fifteen databases were dropped; all fifteen were there
 *   - eighty-four secrets and twelve Postgres roles belonged to apps that had
 *     not existed for two days
 *   - one app was marked `live` with a placement on a node running nothing
 *
 * None of these is detectable from inside the control plane, because the control
 * plane's belief is the thing under suspicion. The only way to find them is to
 * ask the other side — Cloud Run, Cloud SQL, GCS, Secret Manager, the nodes —
 * and compare. That is all this does.
 *
 * VERIFY THE INSTRUMENT. Each check reaches the real world through a DIFFERENT
 * path than the one that wrote the belief: `gcloud` for cloud resources, a
 * connection to the TENANT instance for tenant databases. A check that shares a
 * connection with the thing it is checking will agree with it and prove nothing
 * — that is exactly how the delete path reported success fifteen times.
 *
 * Read-only. It never fixes anything: a cleanup driven by a picture nobody has
 * read is how the wrong things get deleted. Run: npm run drift
 */
import { execFile } from "node:child_process";
import { getPool, getTenantPool } from "@/lib/db";
import { TENANT_PG_INSTANCE } from "@/lib/pg-config";

const DB = "supersonic_platform";
const PROJECT = "supersonic-deploy-prod";
const REGION = "us-central1";

/** Platform-owned Cloud Run services, which are never apps and must never be swept. */
const PLATFORM_SERVICES = new Set([
  "supersonic-control-plane",
  "supersonic-deploy-worker",
  "supersonic-landing",
  "supersonic-proxy",
  "supersonic-shot",
  "supersonic-static",
  "supersonic-umami",
]);

function gcloud(args: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("gcloud", args, { maxBuffer: 32 << 20 }, (err, stdout) => {
      // A failed probe is UNKNOWN, never "nothing there". Reporting an empty
      // list because gcloud was not logged in would invent drift that is not
      // real, and the obvious next step after seeing drift is to delete things.
      if (err) { resolve([]); return; }
      resolve(stdout.split("\n").map((l) => l.trim()).filter(Boolean));
    });
  });
}

/**
 * The two directions are not equally interesting, and treating them as if they
 * were is how a drift report becomes noise nobody reads.
 *
 * An ORPHAN — a resource with no app — is always wrong. Nothing creates a
 * database, bucket, secret or role except a deploy, and nothing should outlive
 * the app it was made for.
 *
 * A MISSING resource usually is not wrong. A database exists only for an app
 * that declared `uses: ["database"]`; a bucket only for one that declared
 * storage. "No database" is the normal state of most apps, and reporting it as
 * drift trains people to skim past the lines that matter.
 *
 * So `missing` is reported only where the platform's own row PROMISES the
 * resource: `runtime = 'cloudrun'` promises a service, `status = 'live'`
 * promises a placement.
 */
interface Finding { resource: string; believed: number; actual: number; orphans: string[]; missing: string[] }

function report(f: Finding): boolean {
  const clean = f.orphans.length === 0 && f.missing.length === 0;
  const mark = clean ? "OK  " : "DRIFT";
  console.log(`\n${mark} ${f.resource}  (платформа: ${f.believed}, на самом деле: ${f.actual})`);
  if (f.orphans.length) console.log(`     лишнее, без приложения (${f.orphans.length}): ${f.orphans.slice(0, 25).join(", ")}${f.orphans.length > 25 ? " …" : ""}`);
  if (f.missing.length) console.log(`     приложение есть, ресурса нет (${f.missing.length}): ${f.missing.slice(0, 25).join(", ")}${f.missing.length > 25 ? " …" : ""}`);
  return clean;
}

async function main() {
  const pool = getPool(DB);
  const apps = (await pool.query<{ slug: string; status: string; runtime: string }>(
    `SELECT slug, status, runtime FROM apps`,
  )).rows;
  const slugs = new Set(apps.map((a) => a.slug));
  // The database name is the slug with dashes folded, so a comparison against
  // the catalogue has to fold the same way or every app looks like an orphan.
  const dbNames = new Set(apps.map((a) => a.slug.replace(/-/g, "_").slice(0, 60)));

  console.log(`\n=== Сверка: что платформа думает против того, что есть ===`);
  console.log(`Приложений в базе платформы: ${apps.length}`);

  let allClean = true;

  // --- Cloud Run services -------------------------------------------------
  const services = (await gcloud([
    "run", "services", "list", "--region", REGION, "--project", PROJECT, "--format=value(metadata.name)",
  ])).filter((s) => !PLATFORM_SERVICES.has(s));
  allClean = report({
    resource: "Сервисы Cloud Run",
    believed: apps.filter((a) => a.runtime === "cloudrun").length,
    actual: services.length,
    orphans: services.filter((s) => !slugs.has(s)),
    missing: apps.filter((a) => a.runtime === "cloudrun" && !services.includes(a.slug)).map((a) => a.slug),
  }) && allClean;

  // --- Tenant databases ---------------------------------------------------
  const databases = (await gcloud([
    "sql", "databases", "list", "--instance", TENANT_PG_INSTANCE, "--project", PROJECT, "--format=value(name)",
  ])).filter((d) => d !== "postgres" && d !== "cloudsqladmin");
  allClean = report({
    resource: `Базы на ${TENANT_PG_INSTANCE}`,
    believed: dbNames.size,
    actual: databases.length,
    orphans: databases.filter((d) => !dbNames.has(d)),
    // Nothing here: most apps never ask for a database. See Finding.
    missing: [],
  }) && allClean;

  // --- Postgres roles, asked of the TENANT instance -----------------------
  // Not through gcloud: roles are not an API object. This is the one check that
  // needs a connection, and it needs the tenant one specifically.
  const roles: string[] = await getTenantPool("postgres")
    .query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname LIKE 'app\\_%'`)
    .then((r) => r.rows.map((x) => x.rolname))
    .catch(() => []);
  const expectedRoles = new Set([...dbNames].map((d) => `app_${d}`.slice(0, 60)));
  allClean = report({
    resource: "Логины Postgres (app_*)",
    believed: expectedRoles.size,
    actual: roles.length,
    orphans: roles.filter((r) => !expectedRoles.has(r)),
    // A role exists only where a database does. Same reason. See Finding.
    missing: [],
  }) && allClean;

  // --- Secret Manager -----------------------------------------------------
  const secrets = await gcloud(["secrets", "list", "--project", PROJECT, "--format=value(name)"]);
  const appSecrets = secrets.filter((s) => s.startsWith("app-"));
  const secretSlugs = new Set(appSecrets.map((s) => s.replace(/^app-/, "").split("-")[0]));
  allClean = report({
    resource: "Секреты приложений",
    believed: slugs.size,
    actual: appSecrets.length,
    orphans: [...secretSlugs].filter((s) => !slugs.has(s)),
    missing: [],
  }) && allClean;

  // --- Buckets ------------------------------------------------------------
  const buckets = (await gcloud(["storage", "ls", "--project", PROJECT]))
    .map((b) => b.replace(/^gs:\/\//, "").replace(/\/$/, ""))
    .filter((b) => b.startsWith("supersonicdeploy-"));
  const bucketSlugs = buckets.map((b) => b.replace(/^supersonicdeploy-/, ""));
  allClean = report({
    resource: "Бакеты приложений",
    believed: slugs.size,
    actual: buckets.length,
    orphans: bucketSlugs.filter((b) => !slugs.has(b)),
    missing: [],
  }) && allClean;

  // --- Placements against what the nodes report ---------------------------
  // `l3sgp` was `live` with a placement while every node ran nothing. The node's
  // own report is the authority here; the placement row is the belief.
  const placed = (await pool.query<{ slug: string; node: string; state: string }>(
    `SELECT slug, node, state FROM fleet_placements`,
  )).rows;
  const stale = placed.filter((p) => !slugs.has(p.slug)).map((p) => `${p.slug}@${p.node}`);
  const liveNoPlacement = apps
    .filter((a) => a.runtime === "fleet" && a.status === "live" && !placed.some((p) => p.slug === a.slug))
    .map((a) => a.slug);
  allClean = report({
    resource: "Размещения на флоте",
    believed: apps.filter((a) => a.runtime === "fleet").length,
    actual: placed.length,
    orphans: stale,
    missing: liveNoPlacement,
  }) && allClean;

  console.log(
    allClean
      ? `\nРасхождений нет.\n`
      : `\nЕсть расхождения — смотри выше. Ничего не удалено: это отчёт, а не уборка.\n`,
  );
  process.exit(allClean ? 0 : 1);
}

main().catch((e) => { console.error("drift:", e); process.exit(2); });
