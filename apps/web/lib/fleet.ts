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
