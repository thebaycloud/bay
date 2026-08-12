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
import { adoptionInput, imageBelongsTo, servedByStatic, dsnIsSealed, type RunService } from "@/lib/adopt";
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

/**
 * Where an app was before the cutover.
 *
 * Created here rather than by a numbered migration for the same reason
 * `agent_runs` is: this is an operator tool, the schema's numbering has already
 * been raced twice in one evening, and a table nothing in the request path reads
 * does not need to join that queue.
 */
async function ensurePreviousUrl(): Promise<void> {
  await getPool(DB).query(
    `CREATE TABLE IF NOT EXISTS app_previous_url (
       slug    text PRIMARY KEY,
       run_url text NOT NULL,
       at      timestamptz NOT NULL DEFAULT now()
     )`);
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

  // REFUSALS, both learned by not making them. See lib/adopt.ts for what each
  // one cost.
  const { rows } = await getPool(DB).query(`SELECT run_url FROM apps WHERE slug=$1`, [slug]);
  if (servedByStatic(rows[0]?.run_url)) {
    throw new Error(`${slug} is served by supersonic-static — there is no container to move`);
  }
  const container = (await describe()).spec.template.spec.containers[0];
  if (dsnIsSealed(container.env ?? [])) {
    throw new Error(
      `${slug} keeps its connection string in a secret that reads 127.0.0.1 — the sidecar ` +
      `address. The spec carries a reference, so there is nothing to rewrite, and rewriting ` +
      `the secret would break the Cloud Run copy still serving from it. Needs a second secret ` +
      `at the fleet address, referenced only by the fleet spec.`);
  }
  if (!imageBelongsTo(slug, i.image)) {
    throw new Error(
      `${slug} runs ${i.image}, which is not its own image — the runner lane points a shared ` +
      `prebuilt at a code bundle fetched at start, so the code is not in the image and placing ` +
      `it would place an empty runtime`);
  }

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
  // The previous address is KEPT, not reconstructed. `--revert` used to rebuild
  // it from the slug, which is right for most apps and wrong for any app served
  // by something else — `o6b54` pointed at `supersonic-static` and the guess
  // sent it somewhere it had never been.
  const { rows } = await getPool(DB).query(`SELECT run_url FROM apps WHERE slug=$1`, [slug]);
  const previous = rows[0]?.run_url ?? null;
  if (previous && previous !== FLEET_LB) {
    await getPool(DB).query(
      `INSERT INTO app_previous_url (slug, run_url) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET run_url = EXCLUDED.run_url`, [slug, previous]);
  }
  await getPool(DB).query(`UPDATE apps SET run_url=$2 WHERE slug=$1`, [slug, FLEET_LB]);
  console.log(`  ${slug}: трафик переключён на флот (прежний адрес запомнен: ${previous})`);
}

async function revert(): Promise<void> {
  const { rows } = await getPool(DB).query(
    `SELECT run_url FROM app_previous_url WHERE slug=$1`, [slug]);
  const previous = rows[0]?.run_url;
  if (!previous) {
    // Refused rather than guessed. A reconstructed URL is right for most apps
    // and wrong for the ones that most need reverting.
    throw new Error(
      `no recorded address for ${slug} — it was never cut over by this tool, so there is ` +
      `nothing to put back. Set apps.run_url by hand if you know what it was.`);
  }
  await getPool(DB).query(
    `UPDATE apps SET runtime='cloudrun', run_url=$2 WHERE slug=$1`, [slug, previous]);
  console.log(`  ${slug}: возвращено на ${previous}`);
}

async function main() {
  await ensurePreviousUrl();
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
