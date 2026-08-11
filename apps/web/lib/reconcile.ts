/**
 * Whether the control plane may act on what it sees, and which nodes it may
 * place on.
 *
 * Both pure, and both here rather than inside the reconcile pass for the same
 * reason `placement-plan.ts` is pure: these are the two rules whose failure mode
 * is two copies of one app writing to one database, and that is not something to
 * find out from production.
 */

export interface NodeSeen {
  name: string;
  /** Epoch millis of the node's last sync. */
  lastSeen: number;
  drain: boolean;
}

/**
 * May the control plane take a placement back from a node it cannot hear?
 *
 * Only while a MAJORITY of live nodes have reported inside the lease window. Below
 * that, the party more likely to be isolated is the control plane itself, and the
 * correct action is none — a reconciler that evicts during its own partition is
 * the two-copies hazard with extra confidence.
 *
 * A DRAINING NODE COUNTS IN NEITHER HALF. It is deliberately leaving, and putting
 * it in the denominator would let a drain push the fleet under the threshold and
 * freeze eviction for everyone else — the operation whose whole purpose is moving
 * apps off a node would stop apps being moved.
 *
 * AN EMPTY FLEET HAS NO QUORUM, stated rather than left to arithmetic. Every
 * predicate over an empty set is vacuously true, and "may I evict?" answering yes
 * when there are no nodes is precisely the bug vacuous truth produces.
 *
 * TWO NODES CANNOT EVICT, and that is the honest answer rather than a lowered
 * bar. A majority of two is two, so one silent node puts a two-node fleet under
 * the threshold at any silence, in either direction. Lowering the rule to "any
 * one node reported" would make such a fleet evict on a partition in whichever
 * direction the control plane happens to be reachable from. The guarantee arrives
 * at three nodes; until then a silent node is a human's problem, and the
 * reconciler should say it is holding rather than look like it is deciding.
 */
export function hasQuorum(nodes: NodeSeen[], now: number, leaseMs: number): boolean {
  const live = nodes.filter((n) => !n.drain);
  if (live.length === 0) return false;
  const reporting = live.filter((n) => now - n.lastSeen <= leaseMs).length;
  return reporting * 2 > live.length;
}

/**
 * Which nodes may be placed on, in the shape the planner takes.
 *
 * Measured against the lease window rather than a separate guess, so "this node
 * is healthy" and "this node's placements are still leased" cannot disagree —
 * two clocks for one fact is how a placement ends up renewed on a node the
 * planner has already written off.
 *
 * A draining node is never healthy for placement however recently it spoke.
 * `chooseNode` already refuses one; the planner is handed a list and cannot
 * know, so it is told here.
 */
export function nodeHealth(nodes: NodeSeen[], now: number, leaseMs: number): { name: string; healthy: boolean }[] {
  return nodes.map((n) => ({ name: n.name, healthy: !n.drain && now - n.lastSeen <= leaseMs }));
}

/**
 * How long a placement is good for, and how often a node renews it.
 *
 * Two minutes against a fifteen-second heartbeat is eight attempts before
 * expiry: it survives everything short of a real partition, and the worst case
 * recovery is about two and a half minutes. Carried in the spec that reaches the
 * node so it can change without shipping an agent.
 */
export const LEASE_MS = 120_000;

/* -------------------------------------------------------------------------- */
/* One pass.                                                                   */
/* -------------------------------------------------------------------------- */

import { getPool } from "./db";
import { planPlacements, type Desired, type Placed, type Step } from "./placement-plan";
import { bumpFleetGeneration } from "./fleet";

const DB = "supersonic_platform";

/**
 * What one reconcile pass did, so the caller can say it rather than guess.
 *
 * `held` is the count of apps that had an expired lease and were left alone for
 * want of quorum. It is reported separately from `steps` because it is the one
 * outcome that looks identical to doing nothing and is not: an operator reading
 * "0 steps" needs to be able to tell a quiet fleet from one the reconciler is
 * deliberately refusing to touch.
 */
export interface PassResult {
  quorum: boolean;
  apps: number;
  steps: Step[];
  held: number;
}

/**
 * Advisory-locked, because two passes acting on one fleet is the thing this
 * whole mechanism exists to prevent.
 *
 * The control plane runs at min-instances=1 but is not pinned to one instance,
 * and the endpoint below is reachable by anything holding the fleet token — so
 * "only one caller" is not a property anything guarantees. A Postgres advisory
 * lock is: it is held by the session, released when it ends, and costs one
 * round trip.
 *
 * A pass that cannot take the lock is not an error. Another pass is already
 * doing the work, and the honest report is that this one had nothing to do.
 */
const LOCK_KEY = 0x5501_1EE7; // "supersonic fleet", arbitrary and fixed

export async function reconcileOnce(now: number = Date.now()): Promise<PassResult | null> {
  const pool = getPool(DB);
  const client = await pool.connect();
  try {
    const got = await client.query(`SELECT pg_try_advisory_lock($1) AS ok`, [LOCK_KEY]);
    if (!got.rows[0]?.ok) return null;
    try {
      return await pass(client, now);
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

type Client = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };

async function pass(client: Client, now: number): Promise<PassResult> {
  const nodes = (await client.query(
    `SELECT name, drain, extract(epoch from last_seen) * 1000 AS last_seen FROM fleet_nodes`,
  )).rows.map((r) => ({ name: r.name as string, drain: Boolean(r.drain), lastSeen: Number(r.last_seen) }));

  const quorum = hasQuorum(nodes, now, LEASE_MS);
  const health = nodeHealth(nodes, now, LEASE_MS);

  // Least loaded first. The planner spreads ONE app across nodes and honours the
  // order it is given; which node is least loaded is a fact about the whole
  // fleet, so it is decided here — two spreading rules in one function would be
  // one too many. Same reasoning `chooseNode` already carries, and deliberately
  // the same policy: spread rather than pack, so a node has room to absorb
  // another's apps and a rollout has room to place beside what it replaces.
  const load = new Map<string, number>(nodes.map((n) => [n.name, 0]));
  const rows = (await client.query(
    `SELECT a.slug,
            a.desired_release,
            a.desired_replicas,
            p.instance, p.node, p.release_id, p.state,
            extract(epoch from p.lease_until) * 1000 AS lease_until,
            (p.spec ? 'dataDir') AS pinned
       FROM apps a
       LEFT JOIN fleet_placements p ON p.slug = a.slug
      WHERE a.runtime = 'fleet'
      ORDER BY a.slug, p.instance`,
  )).rows;

  const byApp = new Map<string, { desired: Desired; placed: Placed[]; pinnedTo: string | null }>();
  for (const r of rows) {
    let e = byApp.get(r.slug);
    if (!e) {
      e = {
        desired: {
          slug: r.slug,
          release: r.desired_release === null ? null : Number(r.desired_release),
          replicas: Number(r.desired_replicas ?? 1),
          pinnedTo: null,
        },
        placed: [],
        pinnedTo: null,
      };
      byApp.set(r.slug, e);
    }
    if (r.instance === null) continue;
    load.set(r.node, (load.get(r.node) ?? 0) + 1);
    // A volume pins the app to the machine holding its disk (spec §8). Recorded
    // from the placement rather than from the app, because it is the placement
    // that names the node the data is on.
    if (r.pinned) e.pinnedTo = r.node as string;
    e.placed.push({
      instance: Number(r.instance),
      node: r.node as string,
      release: Number(r.release_id ?? 0),
      state: (r.state as Placed["state"]) ?? "ready",
      leaseUntil: Number(r.lease_until ?? 0),
    });
  }

  const ordered = [...health].sort((a, b) => (load.get(a.name) ?? 0) - (load.get(b.name) ?? 0));

  const steps: Step[] = [];
  let held = 0;
  for (const [, e] of byApp) {
    const desired = { ...e.desired, pinnedTo: e.pinnedTo };
    const planned = planPlacements(desired, e.placed, ordered, now, quorum);
    // An app with an expired lease that produced no step because the fleet
    // cannot be seen. Counted so a quiet pass and a holding pass do not read the
    // same from outside.
    if (!quorum && !planned.length && e.placed.some((p) => p.leaseUntil < now)) held++;
    steps.push(...planned);
  }

  for (const s of steps) await apply(client, s, now);
  if (steps.length) await bumpFleetGeneration();

  return { quorum, apps: byApp.size, steps, held };
}

async function apply(client: Client, s: Step, now: number): Promise<void> {
  switch (s.kind) {
    case "place":
      // The spec is copied from the release rather than rebuilt, so what a node
      // is handed is byte-for-byte what was recorded as shipped.
      await client.query(
        `INSERT INTO fleet_placements(slug, node, instance, release_id, state, lease_until, spec)
           SELECT $1, $2, $3, $4, 'starting', to_timestamp($5 / 1000.0), r.spec
             FROM releases r WHERE r.id = $4
         ON CONFLICT (slug, instance) DO UPDATE SET
           node = EXCLUDED.node, release_id = EXCLUDED.release_id,
           state = 'starting', lease_until = EXCLUDED.lease_until,
           spec = EXCLUDED.spec, placed_at = now()`,
        [s.slug, s.node, s.instance, s.release, now + LEASE_MS],
      );
      return;
    case "drain":
      await client.query(
        `UPDATE fleet_placements SET state = 'draining' WHERE slug = $1 AND instance = $2`,
        [s.slug, s.instance],
      );
      return;
    case "remove":
    case "evict":
      await client.query(
        `DELETE FROM fleet_placements WHERE slug = $1 AND instance = $2`,
        [s.slug, s.instance],
      );
      return;
  }
}

/**
 * Extend the lease on everything a node holds, because it just spoke.
 *
 * Called from the sync. This is what makes the lease mean anything: a node that
 * is talking keeps its placements, and one that stops loses them — to the
 * CONTROL PLANE's arithmetic, not to any instruction of its own. The node goes
 * on serving either way (spec §10), which is why an outage of this endpoint
 * degrades to "nothing moves" rather than "everything stops".
 */
export async function renewLeases(node: string, now: number = Date.now()): Promise<void> {
  await getPool(DB).query(
    `UPDATE fleet_placements SET lease_until = to_timestamp($2 / 1000.0) WHERE node = $1`,
    [node, now + LEASE_MS],
  );
}
