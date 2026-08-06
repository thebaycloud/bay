import { getPool } from "./db";
import { postgresSink } from "./stages";
import { putAppSecrets } from "./app-secrets";

const DB = "supersonic_platform";

/**
 * Placement: which node runs which app.
 *
 * The control plane decides, the node obeys, and the node is never pushed to —
 * it asks. That direction is the whole availability story: a control plane that
 * is down cannot take running apps with it, and a node that reboots while the
 * control plane is unreachable comes back serving from its cached answer.
 */

export type Runtime = "cloudrun" | "fleet";

/**
 * What a node is told to run.
 *
 * Declared in lib/fleet-spec.ts and re-exported here so the callers that had it
 * from this module keep working. It used to be declared HERE, as a second copy
 * of the agent's `App` that a comment promised was verbatim — and it was not:
 * the agent had `secrets` and `processes` and this did not. One declaration, and
 * a test that checks it against the Go.
 */
import type { AppSpec } from "./fleet-spec";
export type { AppSpec };

export interface NodeReport {
  name: string;
  zone: string;
  internalIp: string;
  memoryBytes: number;
  cpus: number;
}

/**
 * Register a node and mark it alive.
 *
 * Upsert rather than insert: a node that reboots keeps its name, and its
 * placements are keyed on that name. Treating a restarted node as a new one
 * would orphan every app on it.
 */
export async function heartbeatNode(n: NodeReport): Promise<void> {
  await getPool(DB).query(
    `INSERT INTO fleet_nodes(name, zone, internal_ip, memory_bytes, cpus, last_seen)
     VALUES($1, $2, $3, $4, $5, now())
     ON CONFLICT(name) DO UPDATE SET
       zone = EXCLUDED.zone,
       internal_ip = EXCLUDED.internal_ip,
       memory_bytes = EXCLUDED.memory_bytes,
       cpus = EXCLUDED.cpus,
       last_seen = now()`,
    [n.name, n.zone, n.internalIp, n.memoryBytes, n.cpus]
  );
}

/** Everything a given node should be running right now. */
export async function desiredFor(node: string): Promise<AppSpec[]> {
  const r = await getPool(DB).query(
    `SELECT p.spec
       FROM fleet_placements p
       JOIN apps a ON a.slug = p.slug
      WHERE p.node = $1
        AND a.runtime = 'fleet'
      ORDER BY p.slug`,
    [node]
  );
  return r.rows.map((row) => row.spec as AppSpec);
}

/**
 * Place an app on a node.
 *
 * The spec is stored denormalised. Resolving it per pull would put the deploy
 * pipeline's vocabulary — lanes, processes, framework env — on the serving path,
 * and the agent would then need to understand all of it. It understands one
 * shape instead, and the translation happens once, here, at deploy time.
 */
export async function placeApp(slug: string, node: string, spec: AppSpec): Promise<void> {
  await getPool(DB).query(
    `INSERT INTO fleet_placements(slug, node, spec)
     VALUES($1, $2, $3::jsonb)
     ON CONFLICT(slug, node) DO UPDATE SET spec = EXCLUDED.spec, placed_at = now()`,
    [slug, node, JSON.stringify(spec)]
  );
}

export async function unplaceApp(slug: string): Promise<void> {
  await getPool(DB).query(`DELETE FROM fleet_placements WHERE slug = $1`, [slug]);
}

/**
 * Where an app is placed right now, and what it is running there — or null if
 * it has no placement.
 *
 * The node is part of the answer, not just the spec: a restore that placed
 * only the spec would place it on whichever node THIS deploy chose, which is
 * not necessarily the node the app was already running on. `placeApp` upserts
 * on `(slug, node)`, so placing the restored spec on the wrong node writes a
 * second row instead of overwriting the first — two copies of the app running
 * at once, which is exactly what this sequence exists to prevent.
 */
export async function placementFor(slug: string): Promise<{ node: string; spec: AppSpec } | null> {
  const r = await getPool(DB).query(`SELECT node, spec FROM fleet_placements WHERE slug = $1 LIMIT 1`, [slug]);
  return r.rows[0] ? { node: r.rows[0].node as string, spec: r.rows[0].spec as AppSpec } : null;
}

/**
 * Pick a node for an app.
 *
 * Least-loaded by placed-app count, among nodes seen recently and not draining.
 *
 * Deliberately NOT bin-packing by memory. Cost is not a driver for this move,
 * so the fleet runs at roughly half its memory and the useful property is spread
 * — headroom on every node is what lets one node absorb another's apps when one
 * dies. Packing tightly would optimise for the one thing we are not trying to
 * save and give up the one thing we are.
 */
/**
 * How far past its own RAM a node may be committed before it stops taking apps.
 *
 * Overcommit is the design, not an accident: `memoryBytes` on a placement is a
 * cgroup ceiling, not a reservation, and apps spend most of their life nowhere
 * near it. Measured on 5 Aug 2026 — 25 sandboxes on a 64 GiB node, committed to
 * 50 GiB of limits, actually using about 3.
 *
 * So counting commitments strictly would have refused the 26th app on a machine
 * using 5% of its memory. Four is chosen to be far above what today's fleet
 * does and still finite: it is a backstop against a node that has been handed
 * more than it could ever serve, not a scheduler.
 */
const MEMORY_OVERCOMMIT = 4;

/**
 * Which node should take this app.
 *
 * This used to count PLACEMENTS, which treats a 4 GiB app and a 256 MiB one as
 * the same weight, and had no notion of full at all — the only way it returned
 * null was every node going quiet. Two nodes of different sizes would have been
 * filled evenly until the smaller one died.
 *
 * Now it spreads by committed memory and refuses a node already committed past
 * `MEMORY_OVERCOMMIT` times its own. Returning null is a FAILED DEPLOY, which is
 * why the ceiling is deliberately generous: an app refused for capacity that
 * exists is a worse outcome than a node running hot.
 */
export async function chooseNode(): Promise<string | null> {
  const r = await getPool(DB).query(
    `SELECT n.name,
            n.memory_bytes,
            COALESCE(SUM((p.spec->>'memoryBytes')::bigint), 0) AS committed
       FROM fleet_nodes n
       LEFT JOIN fleet_placements p ON p.node = n.name
      WHERE n.drain = false
        AND n.last_seen > now() - interval '90 seconds'
      GROUP BY n.name, n.memory_bytes
      ORDER BY committed ASC, n.name ASC`
  );
  for (const row of r.rows) {
    const memory = Number(row.memory_bytes ?? 0);
    const committed = Number(row.committed ?? 0);
    // A node that never reported its size is taken on trust rather than skipped:
    // refusing to place because a heartbeat lacked a field would be an outage
    // caused by a missing number.
    if (!memory || committed < memory * MEMORY_OVERCOMMIT) return row.name as string;
  }
  return null;
}

/** Which runtime an app is on. Unknown apps read as 'cloudrun', the default. */
export async function runtimeOf(slug: string): Promise<Runtime> {
  const r = await getPool(DB).query(`SELECT runtime FROM apps WHERE slug = $1`, [slug]);
  return (r.rows[0]?.runtime as Runtime) ?? "cloudrun";
}

/**
 * Move one app between runtimes.
 *
 * This is the reverse gear the cutover plan depends on. Moving back to Cloud Run
 * drops the placement, so the node stops running it on its next reconcile
 * without anyone telling it to.
 */
export async function setRuntime(slug: string, runtime: Runtime): Promise<void> {
  const pool = getPool(DB);
  await pool.query(`UPDATE apps SET runtime = $2 WHERE slug = $1`, [slug, runtime]);
  if (runtime === "cloudrun") await unplaceApp(slug);
}

/**
 * One process's most recent start failure, as the node that holds it sees it.
 *
 * The mirror of `ProcessFault` in services/fleet/agent/desired.go. Nothing
 * enforces that the two stay in step — the same drift risk test/fleet-spec.test.ts
 * exists to catch for `App`, and a drift test for this pair belongs in the next
 * slice.
 */
export interface ProcessFault {
  slug: string;
  process: string;
  fault: string;
  detail?: string;
}

/**
 * Replace this node's fault set with what it just reported.
 *
 * A row is accepted only for a (slug, node) pair that already exists in
 * fleet_placements. FLEET_TOKEN is a shared secret and any holder can post as
 * any node, so without this the channel upgrades a leaked token from "read
 * desired state" to "mark another node's apps failed and steer their deploy
 * verdicts". A node cannot report on apps it was never given.
 *
 * One statement, not a transaction, because the file has no transaction idiom
 * and does not need one here: the DELETE and the INSERT are disjoint by
 * construction — the DELETE only removes rows the report does NOT mention — so
 * the whole replacement is atomic without a client checked out of the pool.
 *
 * Callers must not call this at all when the node sent no `processes` field.
 * Absent means "this agent does not report"; passing `[]` for it would clear
 * every row an older agent binary knows nothing about.
 */
export async function recordNodeFaults(node: string, faults: ProcessFault[]): Promise<void> {
  await getPool(DB).query(
    `WITH incoming AS (
       SELECT DISTINCT ON (slug, process) slug, process, fault, detail
         FROM jsonb_to_recordset($2::jsonb)
              AS t(slug text, process text, fault text, detail text)
        WHERE slug IS NOT NULL AND process IS NOT NULL AND fault IS NOT NULL
        ORDER BY slug, process
     ),
     accepted AS (
       SELECT i.*
         FROM incoming i
         JOIN fleet_placements p ON p.slug = i.slug AND p.node = $1
     ),
     cleared AS (
       DELETE FROM fleet_process_faults f
        WHERE f.node = $1
          AND NOT EXISTS (
            SELECT 1 FROM accepted a WHERE a.slug = f.slug AND a.process = f.process
          )
     )
     INSERT INTO fleet_process_faults(slug, node, process, fault, detail, reported_at)
     SELECT a.slug, $1, a.process, a.fault, a.detail, now() FROM accepted a
     ON CONFLICT (slug, node, process) DO UPDATE
        SET fault = EXCLUDED.fault,
            detail = EXCLUDED.detail,
            -- Refreshed on every sync even when nothing changed, and nodeFaultFor
            -- reads it: a row nobody is still reporting must go stale rather than
            -- steer deploys forever.
            reported_at = now()`,
    [node, JSON.stringify(faults)]
  );
}

/**
 * Is a FRESH node reporting that this app's failure is the node's own?
 *
 * Two independent freshness conditions, and they answer different questions.
 *
 * The NODE's, which the plan named: `KillMode=process` means restarting the
 * agent does not stop the sandboxes, so a node that has not reported recently is
 * `unknown` — not `down` — and unknown must never fail a deploy. The 90-second
 * window is the one chooseNode already uses.
 *
 * The ROW's, which it did not: a node can go on heartbeating while no longer
 * reporting faults at all — roll the agent binary back to one built before this
 * field existed and that is exactly what happens. The sync would then leave the
 * stored row untouched (correctly: absent means "does not report"), and a fault
 * nobody is still claiming would blame the platform for every future deploy of
 * that app, forever. `reported_at` is refreshed on every sync, so a fault that is
 * still true is never more than ten seconds old, and this costs a genuine one
 * nothing.
 */
export async function nodeFaultFor(slug: string): Promise<{ node: string; detail: string } | null> {
  const r = await getPool(DB).query(
    `SELECT f.node, coalesce(f.detail, '') AS detail
       FROM fleet_process_faults f
       JOIN fleet_nodes n ON n.name = f.node
       JOIN fleet_placements p ON p.slug = f.slug AND p.node = f.node
      WHERE f.slug = $1
        AND f.fault = 'node'
        AND n.last_seen > now() - interval '90 seconds'
        AND f.reported_at > now() - interval '90 seconds'
      ORDER BY f.reported_at DESC
      LIMIT 1`,
    [slug]
  );
  return r.rows[0] ? { node: r.rows[0].node as string, detail: r.rows[0].detail as string } : null;
}

/**
 * One process a node says it is CONFIRMED to be running.
 *
 * The mirror of `ProcessState` in services/fleet/agent/desired.go, held to it by
 * a drift test in test/fleet-spec.test.ts — the same one `ProcessFault` has, and
 * for a sharper reason. A field renamed on one side arrives as undefined, the
 * comparison in `runVerdict` finds no match, and every worker-only fleet deploy
 * rolls back with a reason nobody can act on.
 */
export interface ProcessState {
  slug: string;
  process: string;
  image: string;
  command?: string[];
  /**
   * Whether the node's own probe is getting an answer.
   *
   * Optional, and the three states are all different. `true` is answering;
   * `false` is asked and silent; ABSENT is nobody asked — a worker has no port,
   * and an agent older than this field says nothing at all. Only the explicit
   * `false` is a failure, because refusing on absence would refuse every
   * worker-only app and every deploy made before the node was rebuilt.
   */
  healthy?: boolean;
  /**
   * How long the node's most recent start of this process took to pull its
   * image and boot the sandbox, in milliseconds. Mirrors
   * services/fleet/agent/desired.go's ProcessState.PullMs/BootMs — read that
   * comment for why these are the one pair of fields here that are NOT
   * present tense: every other field restates the process's current state on
   * every sync, but a duration describes a single START EVENT and the agent
   * sends it on exactly one report, then forgets it. `recordStartTiming`
   * below is what a reader does with that one report; there is no row to
   * re-read on the next sync because there won't be one.
   */
  pullMs?: number;
  bootMs?: number;
}

/**
 * Replace this node's running set with what it just reported.
 *
 * Deliberately the same statement shape as `recordNodeFaults`, including the
 * `accepted` join on fleet_placements — and that join is doing more work here.
 * There it stopped a leaked FLEET_TOKEN from marking another node's apps failed;
 * here a forged row would steer a deploy to PASS, flipping run_url onto a node
 * that is running nothing. A node still cannot say anything about an app it was
 * never given.
 *
 * Callers must not call this at all when the node sent no `running` field.
 * Absent means "this agent does not report"; passing `[]` for it would clear
 * every row an older agent binary knows nothing about — and unlike a cleared
 * fault, a cleared running-row fails the next deploy of that app.
 */
/**
 * The `healthy` column, guaranteed before the first write that needs it.
 *
 * db/017 is the canonical schema, but migrations are a separate command — they
 * do not run as part of a deploy. So shipping code that writes a column nobody
 * has added yet would not degrade: `recordNodeRunning` would throw on every
 * sync, the node's running reports would stop arriving, and every fleet deploy
 * would then fail its verify for want of a row. Same shape as `ensure()` in
 * lib/deploy-runs.ts, and idempotent for the same reason.
 */
let healthColumn: Promise<void> | null = null;
function ensureHealthColumn(): Promise<void> {
  if (!healthColumn) {
    healthColumn = getPool(DB)
      .query(`ALTER TABLE fleet_process_running ADD COLUMN IF NOT EXISTS healthy boolean`)
      .then(() => undefined)
      .catch((e) => { healthColumn = null; throw e; });
  }
  return healthColumn;
}

/**
 * Whether what a node is running is evidence that an app is NOT failed.
 *
 * A `failed` status is written by a deploy and never revisited. `a8ebb` has
 * carried one for days while serving perfectly on the fleet: the deploy that set
 * it really did fail — its Cloud Run revision could not start — and then the app
 * moved and started working, and nothing said so. The dashboard shows it as
 * down, because the list's `ready` is `status === 'live'`. 21 of 83 apps carry
 * the flag today.
 *
 * The node's report is the ground truth, and it already arrives every few
 * seconds, so the correction costs nothing extra.
 *
 * Absent health does not block it: a worker has no port, nobody asked, and
 * requiring a probe would leave every worker-only app marked failed forever —
 * the same mistake the nullable health field was introduced to end. An explicit
 * `false` DOES block it: a web process that is up and answering nothing is not a
 * working app, and clearing the flag there would hide a real outage.
 */
export function clearsFailedStatus(running: ProcessState[]): boolean {
  if (running.length === 0) return false;
  return !running.some((p) => p.healthy === false);
}

/**
 * Turn a node's one-shot pull/boot timing into deploy_stages rows.
 *
 * Two ROWS per process, not one row with two numbers: `fleet-pull` and
 * `fleet-boot` are their own stage names (lib/stage-names.ts) precisely so a
 * slow deploy can be attributed to a slow registry or a slow sandbox boot
 * without a second dashboard. docs/research/fleet-deploy-time.md named the
 * unsplit cost of the two together the largest blind spot in the whole
 * deploy path — before this, neither number reached anywhere the control
 * plane could read, let alone separately.
 *
 * `lane` is written as `"unknown"` rather than looked up. This runs off the
 * node's own async sync, which carries nothing but slug/process/image — a
 * lane lookup here would be an extra query on every ten-second sync, for
 * every node, to label a row that is already fully identified by its stage
 * name and slug. stage-names.ts's own comment on `unpack` sets the
 * precedent: a LANE_KNOWN stage does not have to be written by something
 * that knows the lane.
 *
 * `runId` is null for the same reason: the node has no notion of a deploy
 * attempt, only of a slug. A reader that wants to line this up with one
 * deploy's other stages joins on slug and a time window, the same fallback
 * every pre-`run_id` row already relies on (stages.ts).
 *
 * Authorized the same way recordNodeRunning's own upsert is: a node may only
 * speak for a slug fleet_placements actually has it running, so a stray or
 * compromised node cannot attribute its own slow pull to somebody else's app.
 *
 * Never allowed to fail the caller. recordNodeRunning's own job — the
 * running-report upsert above — must complete whether or not this succeeds,
 * and one process's stage write failing must not stop a SIBLING row (the
 * other stage, or the next process) from being attempted, so each write gets
 * its own try/catch. The fleet sync route wraps the whole call in `.catch`
 * too, but that would blame recordNodeRunning's actual job for a problem
 * that is really this telemetry's, which is a worse failure than losing one
 * measurement.
 */
async function recordStartTiming(node: string, running: ProcessState[]): Promise<void> {
  const timed = running.filter((p) => p.pullMs !== undefined || p.bootMs !== undefined);
  if (timed.length === 0) return;

  const placed = await getPool(DB).query(`SELECT slug FROM fleet_placements WHERE node = $1`, [node]);
  const placedSlugs = new Set(placed.rows.map((r) => r.slug as string));

  const now = new Date();
  for (const p of timed) {
    if (!placedSlugs.has(p.slug)) continue;
    if (p.pullMs !== undefined) {
      try {
        await postgresSink.write({
          slug: p.slug, lane: "unknown", stage: "fleet-pull",
          startedAt: new Date(now.getTime() - p.pullMs), endedAt: now,
          outcome: "ok", runId: null,
        });
      } catch (e) {
        console.error(`fleet sync (${node}): failed to record fleet-pull for ${p.slug}/${p.process}`, e);
      }
    }
    if (p.bootMs !== undefined) {
      try {
        await postgresSink.write({
          slug: p.slug, lane: "unknown", stage: "fleet-boot",
          startedAt: new Date(now.getTime() - p.bootMs), endedAt: now,
          outcome: "ok", runId: null,
        });
      } catch (e) {
        console.error(`fleet sync (${node}): failed to record fleet-boot for ${p.slug}/${p.process}`, e);
      }
    }
  }
}

export async function recordNodeRunning(node: string, running: ProcessState[]): Promise<void> {
  await ensureHealthColumn();
  await getPool(DB).query(
    `WITH incoming AS (
       SELECT DISTINCT ON (slug, process) slug, process, image, command, healthy
         FROM jsonb_to_recordset($2::jsonb)
              AS t(slug text, process text, image text, command jsonb, healthy boolean)
        WHERE slug IS NOT NULL AND process IS NOT NULL AND image IS NOT NULL
        ORDER BY slug, process
     ),
     accepted AS (
       SELECT i.*
         FROM incoming i
         JOIN fleet_placements p ON p.slug = i.slug AND p.node = $1
     ),
     cleared AS (
       DELETE FROM fleet_process_running f
        WHERE f.node = $1
          AND NOT EXISTS (
            SELECT 1 FROM accepted a WHERE a.slug = f.slug AND a.process = f.process
          )
     )
     INSERT INTO fleet_process_running(slug, node, process, image, command, healthy, reported_at)
     SELECT a.slug, $1, a.process, a.image, a.command, a.healthy, now() FROM accepted a
     ON CONFLICT (slug, node, process) DO UPDATE
        SET image = EXCLUDED.image,
            command = EXCLUDED.command,
            healthy = EXCLUDED.healthy,
            reported_at = now()`,
    [node, JSON.stringify(running)]
  );

  // Correct a `failed` an app has outlived. Grouped by slug, because one app can
  // report several processes and a single silent web process disqualifies the
  // whole app — see clearsFailedStatus.
  //
  // Only `failed` is touched. `deploying` must not be overwritten: a node can be
  // running the PREVIOUS image of an app whose new deploy is still building, and
  // flipping that row to live would report the new deploy as finished.
  const bySlug = new Map<string, ProcessState[]>();
  for (const p of running) bySlug.set(p.slug, [...(bySlug.get(p.slug) ?? []), p]);
  const recovered = [...bySlug.entries()].filter(([, ps]) => clearsFailedStatus(ps)).map(([s]) => s);
  if (recovered.length) {
    await getPool(DB).query(
      `UPDATE apps SET status = 'live' WHERE slug = ANY($1::text[]) AND status = 'failed'`,
      [recovered]
    );
  }

  // Best-effort and last: see recordStartTiming's own comment for why this
  // function's real job, above, must complete regardless of what happens
  // here.
  try {
    await recordStartTiming(node, running);
  } catch (e) {
    console.error(`fleet sync (${node}): start-timing recording failed`, e);
  }
}

/**
 * What a FRESH node says it is running for this app, right now.
 *
 * Two freshness conditions, the same pair `nodeFaultFor` uses and for the same
 * reasons: `KillMode=process` means a restarted agent has not stopped anything,
 * so a node that has not heartbeated in 90s is `unknown`; and a node can go on
 * heartbeating while no longer sending this field at all — roll the agent back
 * to a binary built before it existed and that is exactly what happens. The sync
 * correctly leaves the stored rows alone in that case, so without the row's own
 * window they would vouch for a process nobody is still claiming.
 *
 * The tight window is not here. The node only reports a process it watched runsc
 * confirm within the last 30 seconds, so this is the second of two — its job is
 * to catch a node that stopped talking, which is exactly what 90 seconds is the
 * established answer to.
 */
export async function runningOnNode(slug: string, node: string): Promise<ProcessState[]> {
  const r = await getPool(DB).query(
    `SELECT f.process, f.image, f.command, f.healthy
       FROM fleet_process_running f
       JOIN fleet_nodes n ON n.name = f.node
      WHERE f.slug = $1
        AND f.node = $2
        AND n.last_seen > now() - interval '90 seconds'
        AND f.reported_at > now() - interval '90 seconds'
      ORDER BY f.process`,
    [slug, node]
  );
  return r.rows.map((row) => ({
    slug,
    process: row.process as string,
    image: row.image as string,
    command: (row.command as string[] | null) ?? undefined,
    // null stays undefined rather than becoming false: an unprobed worker and an
    // agent that does not report health must not read as a failing app.
    healthy: row.healthy === null || row.healthy === undefined ? undefined : Boolean(row.healthy),
  }));
}

export interface FleetNodeRow {
  name: string;
  zone: string;
  internal_ip: string;
  memory_bytes: string;
  cpus: number;
  drain: boolean;
  last_seen: Date;
  placed: string;
}

export async function listNodes(): Promise<FleetNodeRow[]> {
  const r = await getPool(DB).query(
    `SELECT n.*, count(p.slug) AS placed
       FROM fleet_nodes n
       LEFT JOIN fleet_placements p ON p.node = n.name
      GROUP BY n.name
      ORDER BY n.name`
  );
  return r.rows as FleetNodeRow[];
}

/* -------------------------------------------------------------------------- */
/* Changing an app's environment on a node.                                    */
/* -------------------------------------------------------------------------- */

/**
 * Set and unset environment variables on a PLACED app.
 *
 * `supersonic env set` has always been `gcloud run services update`, which for
 * an app on a node is wrong in one of two ways. A fleet-native app has no Cloud
 * Run service, so the command fails outright. An app that MIGRATED to the fleet
 * still has its old service — nothing deletes it — so the command succeeds,
 * writes a revision nothing routes to, reports success, and changes nothing
 * about the running app. The second is much worse than the first.
 *
 * The spec is the app's environment on this runtime, so that is what is edited.
 * `env` is merged rather than replaced, matching `--update-env-vars`: a redeploy
 * must not drop a value somebody set by hand, which is the property the Cloud Run
 * path documents as load-bearing.
 *
 * Returns the keys the app now has, or null when it is not placed anywhere —
 * the caller has to be able to tell "no such placement" from "no variables".
 */
export async function setPlacementEnv(
  slug: string,
  set: Record<string, string>,
  unset: string[] = [],
  /** How a value is written to Secret Manager. A port, so this is testable. */
  storeSecrets: (slug: string, vars: Record<string, string>) => Promise<{ key: string; name: string }[]>
    = async (s, vars) => (await putAppSecrets(s, vars, process.env.APP_RUNTIME_SERVICE_ACCOUNT ?? "", () => {})).stored,
): Promise<string[] | null> {
  const pool = getPool(DB);
  const r = await pool.query(`SELECT node, spec FROM fleet_placements WHERE slug = $1`, [slug]);
  const row = r.rows[0];
  if (!row) return null;

  const spec = row.spec as AppSpec;
  const env: Record<string, string> = { ...(spec.env ?? {}) };
  const secrets: Record<string, string> = { ...(spec.secrets ?? {}) };

  // A key that ARRIVED as a secret is written back as one.
  //
  // Everything from the project's `.env` lands in Secret Manager, so for most
  // apps every name worth changing lives in `secrets` and not in `env`. Editing
  // only `env` — which is what this did — wrote a plain variable beside a secret
  // of the same name and left the old value in place: the node appends secrets
  // after env, so the stale one won, and `env unset` removed a key that was
  // never there while the listing kept showing it from `secrets`. That is what
  // "✓ set … — new revision rolling out" was saying about nothing.
  const asSecret: Record<string, string> = {};
  for (const [k, v] of Object.entries(set)) {
    if (!k) continue;
    if (k in secrets) asSecret[k] = String(v);
    else env[k] = String(v);
  }
  let wroteSecrets = false;
  if (Object.keys(asSecret).length) {
    for (const ref of await storeSecrets(slug, asSecret)) {
      secrets[ref.key] = ref.name;
      wroteSecrets = true;
    }
  }
  // Unset removes the NAME from both maps. The secret itself is left in Secret
  // Manager: unlinking is reversible and deleting is not, and nothing else the
  // platform does destroys a customer's value on a one-word command.
  for (const k of unset) {
    delete env[k];
    if (k in secrets) {
      delete secrets[k];
      wroteSecrets = true;
    }
  }

  // Written back whole. The spec is one JSON document the agent reads verbatim,
  // and a partial update of it is not a thing the agent can be handed.
  const next: AppSpec = { ...spec, env, secrets };
  // The node resolves a secret to its latest version, so a changed VALUE leaves
  // the spec identical and nothing restarts. This is the field that moves.
  if (wroteSecrets) next.secretsVersion = new Date().toISOString();
  await pool.query(
    `UPDATE fleet_placements SET spec = $3::jsonb WHERE slug = $1 AND node = $2`,
    [slug, row.node, JSON.stringify(next)],
  );
  return [...Object.keys(env), ...Object.keys(secrets)].sort();
}

/** The variable NAMES a placed app has. Values are never returned. */
export async function placementEnvKeys(slug: string): Promise<string[] | null> {
  const r = await getPool(DB).query(`SELECT spec FROM fleet_placements WHERE slug = $1`, [slug]);
  const row = r.rows[0];
  if (!row) return null;
  const spec = row.spec as AppSpec;
  return [...Object.keys(spec.env ?? {}), ...Object.keys(spec.secrets ?? {})].sort();
}

/* -------------------------------------------------------------------------- */
/* Where the apps this node does NOT hold actually live.                       */
/* -------------------------------------------------------------------------- */

/** One app that lives on some other node, and the router address that reaches it. */
export interface PeerRoute {
  slug: string;
  /** `<internal-ip>:<router-port>` — the other node's router, not the app. */
  addr: string;
}

/**
 * The fleet-wide slug → node map, minus this node's own apps.
 *
 * The load balancer fans requests across nodes without knowing where anything
 * is, which is exactly right with one node and breaks the moment there are two:
 * roughly half of every app's traffic lands on a machine that does not hold it,
 * and the router answers `Not on this node` — a 404 for an app that is up.
 *
 * So each node is told where the others' apps are and forwards on a miss. Told,
 * rather than discovering: the control plane already knows, and a node querying
 * its peers would be a second source of truth that can disagree with the first.
 *
 * Only nodes that have reported recently, for the same reason `chooseNode` only
 * places on those — forwarding to a machine that stopped answering turns one
 * app's outage into a timeout on every request for it.
 */
export async function peersFor(node: string, routerPort = 8080): Promise<PeerRoute[]> {
  const r = await getPool(DB).query(
    `SELECT p.slug, n.internal_ip
       FROM fleet_placements p
       JOIN apps a ON a.slug = p.slug
       JOIN fleet_nodes n ON n.name = p.node
      WHERE p.node <> $1
        AND a.runtime = 'fleet'
        AND n.drain = false
        AND n.last_seen > now() - interval '90 seconds'
        AND n.internal_ip IS NOT NULL
      ORDER BY p.slug`,
    [node],
  );
  return r.rows
    .filter((row) => row.internal_ip)
    .map((row) => ({ slug: row.slug as string, addr: `${row.internal_ip}:${routerPort}` }));
}
