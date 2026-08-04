import { getPool } from "./db";

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
export async function chooseNode(): Promise<string | null> {
  const r = await getPool(DB).query(
    `SELECT n.name, count(p.slug) AS placed
       FROM fleet_nodes n
       LEFT JOIN fleet_placements p ON p.node = n.name
      WHERE n.drain = false
        AND n.last_seen > now() - interval '90 seconds'
      GROUP BY n.name
      ORDER BY placed ASC, n.name ASC
      LIMIT 1`
  );
  return r.rows[0]?.name ?? null;
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
