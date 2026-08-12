/**
 * Move a live Cloud Run app onto the fleet, without rebuilding it.
 *
 *   node --import tsx scripts/adopt.ts <slug>            what would happen
 *   node --import tsx scripts/adopt.ts <slug> --place    record a release, place it
 *   node --import tsx scripts/adopt.ts <slug> --cutover  move traffic
 *   node --import tsx scripts/adopt.ts <slug> --revert   put it back on Cloud Run
 *
 * ## Why the steps are separate
 *
 * `--place` marks the app `fleet` and records a release. That tells the
 * RECONCILER to place it; it does not move a single request, because the edge
 * routes on `run_url` and this does not touch it. The app goes on serving from
 * Cloud Run while a copy of it starts on a node.
 *
 * `--cutover` is the only step a user can feel, and it is one UPDATE. `--revert`
 * is the same statement backwards.
 *
 * ## Verify between them, and not from outside
 *
 * The first adoption looked perfect from the internet and was completely broken.
 * A private app answers 401 at the edge because the sign-in gate runs BEFORE the
 * upstream is called — so the public response is identical whether the app is
 * healthy, wedged, or absent. It said 401 before the cutover and 401 after,
 * while every real request got a 500.
 *
 * Ask a NODE instead. It is the only observer that has actually spoken to the
 * app:
 *
 *   gcloud compute ssh fleet-lab-1 --zone us-central1-a --tunnel-through-iap \
 *     --command 'S=$(sudo grep -oE "FLEET_EDGE_SECRET=.*" /etc/supersonic/fleet.env | cut -d= -f2-);
 *                curl -s -o /dev/null -w "%{http_code}\n" \
 *                  -H "Host: <slug>.supersonic.cv" -H "x-supersonic-edge: $S" \
 *                  http://localhost:8080/'
 *
 * 200 on every node, then cut over.
 */
import { execFileSync } from "node:child_process";
import { adoptionInput, type RunService } from "@/lib/adopt";
import { buildAppSpec } from "@/lib/fleet-spec";
import { recordRelease, setDesired } from "@/lib/reconcile";
import { resolveImageDigest } from "@/lib/gcp-rest";
import { getPool } from "@/lib/db";

const DB = "supersonic_platform";
const REGION = "us-central1";
const PROJECT = "supersonic-deploy-prod";
/** Where the edge sends a fleet app. Every fleet app carries this exact value. */
const FLEET_LB = "http://8.232.255.172";

const slug = process.argv[2];
const mode = process.argv.slice(3).find((a) => a.startsWith("--")) ?? "--dry-run";
if (!slug) {
  console.error("usage: adopt.ts <slug> [--place | --cutover | --revert]");
  process.exit(2);
}

function gcloud(args: string[]): string {
  return execFileSync("gcloud", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

async function describe(): Promise<RunService> {
  return JSON.parse(gcloud(["run", "services", "describe", slug,
    "--region", REGION, "--project", PROJECT, "--format=json"]));
}

async function place(dryRun: boolean): Promise<void> {
  const i = adoptionInput(slug, await describe());

  // A release recorded on `:latest` means something different tomorrow. The
  // deploy path resolves its own digests for the same reason.
  let image = i.image;
  if (i.imageIsTag) {
    const digest = await resolveImageDigest(image);
    if (!digest) throw new Error(`no digest for ${image} — refusing to record a release on a tag`);
    image = `${image.split(":")[0]}@${digest}`;
  }

  const spec = buildAppSpec({
    slug, image,
    env: i.env,
    secrets: i.secrets,
    // Absent, not empty: the agent reads a zero-length process list as ONE
    // IMPLICIT WEB PROCESS started from the image's own entrypoint, which is
    // exactly what Cloud Run was doing with it.
    processes: [],
    port: i.port,
    memoryBytes: i.memoryBytes || undefined,
    cpuShares: i.cpuShares || undefined,
  });

  console.log(`  образ    ${image}`);
  console.log(`  порт     ${spec.port}   память ${(spec.memoryBytes / 1024 ** 3).toFixed(1)}Gi   cpu ${spec.cpuShares}`);
  console.log(`  env      ${Object.keys(spec.env ?? {}).length}   секретов ${Object.keys(spec.secrets ?? {}).length}`);
  const dsn = (spec.env ?? {})["DATABASE_URL"];
  if (dsn) console.log(`  база     ${dsn.includes("10.200.0.1") ? "перенаправлена на прокси узла" : "ВНЕШНЯЯ — оставлена как есть"}`);

  if (dryRun) { console.log("\n  сухой прогон — ничего не записано"); return; }

  const rel = await recordRelease(slug, image, spec);
  await setDesired(slug, rel.id);
  // Only now does the reconciler see it: it selects `WHERE runtime = 'fleet'`.
  await getPool(DB).query(`UPDATE apps SET runtime='fleet' WHERE slug=$1`, [slug]);
  console.log(`\n  релиз ${rel.id} (версия ${rel.version}) записан, приложение помечено флотским`);
  console.log("  реконсилер разместит его; ТРАФИК НЕ ТРОНУТ — проверьте узлы, потом --cutover");
}

async function cutover(): Promise<void> {
  await getPool(DB).query(`UPDATE apps SET run_url=$2 WHERE slug=$1`, [slug, FLEET_LB]);
  console.log(`  ${slug}: трафик переключён на флот`);
}

async function revert(): Promise<void> {
  await getPool(DB).query(
    `UPDATE apps SET runtime='cloudrun', run_url=$2 WHERE slug=$1`,
    [slug, `https://${slug}-uyuwsbguuq-uc.a.run.app`]);
  console.log(`  ${slug}: возвращено на Cloud Run`);
}

async function main() {
  if (mode === "--place") await place(false);
  else if (mode === "--cutover") await cutover();
  else if (mode === "--revert") await revert();
  else await place(true);

  const r = await getPool(DB).query(
    `SELECT runtime, run_url, desired_release FROM apps WHERE slug=$1`, [slug]);
  console.log("  сейчас:", JSON.stringify(r.rows[0] ?? null));
  process.exit(0);
}
main().catch((e) => { console.error("сбой:", e instanceof Error ? e.message : e); process.exit(1); });
