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

export async function reconcileOnce(now: number = Date.now(), only?: string): Promise<PassResult | null> {
  const pool = getPool(DB);
  const client = await pool.connect();
  try {
    const got = await client.query(`SELECT pg_try_advisory_lock($1) AS ok`, [LOCK_KEY]);
    if (!got.rows[0]?.ok) return null;
    try {
      return await pass(client, now, only);
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

type Client = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };

/**
 * One convergence, over the whole fleet or over a single app.
 *
 * Exported for the tests and for `convergeApp`, which is how a DEPLOY reaches
 * this: the spec's step 3 is "the placement function creates placements for V —
 * the same function the reconciler calls", and the cheapest way to mean that
 * literally is one function with an argument rather than two that must be kept
 * in step.
 *
 * `only` NARROWS THE PLANNING LOOP AND NOT THE QUERY, which is the whole subtlety
 * of the parameter. "Which node is least loaded" is a fact about every placement
 * on the fleet; reading one app's rows would show every other node as empty and
 * send the new instance to whichever node happened to be first. So every app is
 * read and counted, and only the planning is restricted.
 */
export async function pass(client: Client, now: number, only?: string): Promise<PassResult> {
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
  for (const [appSlug, e] of byApp) {
    // Counted above, planned for only when asked. See the note on `only`.
    if (only !== undefined && appSlug !== only) continue;
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

  return { quorum, apps: only === undefined ? byApp.size : (byApp.has(only) ? 1 : 0), steps, held };
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

/* -------------------------------------------------------------------------- */
/* Releases: what shipped, recorded once.                                      */
/* -------------------------------------------------------------------------- */

import type { AppSpec } from "./fleet-spec";

/**
 * Record one successful build as an immutable release, and return it.
 *
 * Immutable by rule rather than by permission: nothing updates this table. A
 * release is the record of what shipped, and the thing that ships the next one
 * must not be able to edit it.
 *
 * The version is taken inside the INSERT rather than read and then written,
 * because two deploys of one app can be in flight — `supersedeRunsFor` cancels
 * the older run but not instantly — and read-then-write would give both the same
 * number. The unique constraint would then refuse one of them, which is a deploy
 * failing on a race it did not cause.
 */
export async function recordRelease(
  slug: string,
  image: string,
  spec: AppSpec,
): Promise<{ id: number; version: number }> {
  const r = await getPool(DB).query(
    `INSERT INTO releases (slug, version, base_image, code_image, spec)
       SELECT $1, COALESCE(max(version), 0) + 1, $2, $2, $3::jsonb
         FROM releases WHERE slug = $1
     RETURNING id, version`,
    [slug, image, JSON.stringify(spec)],
  );
  return { id: Number(r.rows[0].id), version: Number(r.rows[0].version) };
}

/** Which release an app is currently asked to run, or null if it has none. */
export async function desiredRelease(slug: string): Promise<number | null> {
  const r = await getPool(DB).query(`SELECT desired_release FROM apps WHERE slug = $1`, [slug]);
  const v = r.rows[0]?.desired_release;
  return v === null || v === undefined ? null : Number(v);
}

/**
 * Ask for a release. This is the whole of what a deploy does to change what runs.
 *
 * And the whole of a rollback, in the other direction — which is why `rollback`
 * stops being a 501 on this runtime: it is this call with an older id.
 */
export async function setDesired(slug: string, release: number | null): Promise<void> {
  await getPool(DB).query(`UPDATE apps SET desired_release = $2 WHERE slug = $1`, [slug, release]);
  await bumpFleetGeneration();
}

/* -------------------------------------------------------------------------- */
/* Readiness: reported by the node, never inferred from outside.               */
/* -------------------------------------------------------------------------- */

/** A placement waiting to be told it is serving. */
export interface Starting {
  slug: string;
  instance: number;
  /** The image of the release this instance was placed with. */
  image: string;
}

/** What a node says it is confirmed to be running, from its own sync report. */
export interface Confirmed {
  slug: string;
  image: string;
  /**
   * Whether it is ANSWERING, not merely present — and absent when the question
   * does not apply. A worker has no port to probe, so the node reports no health
   * for it at all, and reading that absence as "not healthy" would leave a
   * worker-only app unable to ever finish a rollout.
   */
  healthy?: boolean;
}

/**
 * Which starting placements the node has just vouched for.
 *
 * The rollout turns on this: `planPlacements` will not drain the old instance
 * until the new one is `ready`. Nothing wrote that field, so a rollout placed its
 * new instance and stopped there — permanently. Found on q6doa, sitting at
 * instance 0 ready on release 25 and instance 1 starting on 29, with the
 * reconciler correctly reporting no steps because the new one was not cover yet.
 *
 * THE IMAGE IS THE PREDICATE, not the slug. A node still running the version
 * being replaced reports the same slug, and promoting on that would mark the new
 * instance ready on the strength of the OLD one answering — the same false
 * positive `placeOnFleet` already guards its probe against, arriving one layer
 * down.
 */
export function readyInstances(
  starting: Starting[],
  confirmed: Confirmed[],
): { slug: string; instance: number }[] {
  return starting
    .filter((s) =>
      confirmed.some((c) =>
        c.slug === s.slug && c.image === s.image && c.healthy !== false))
    .map((s) => ({ slug: s.slug, instance: s.instance }));
}

/**
 * Promote everything this node has just confirmed, on the sync that confirmed it.
 *
 * Here rather than in the reconcile pass because this is the node speaking about
 * itself, and the pass runs on a clock that has nothing to do with when a process
 * came up. Waiting for the next tick would add up to a minute to every rollout
 * for no reason.
 */
export async function promoteReady(
  node: string,
  confirmed: Confirmed[],
): Promise<number> {
  if (!confirmed.length) return 0;
  const pool = getPool(DB);
  const rows = (await pool.query(
    `SELECT p.slug, p.instance, r.code_image AS image
       FROM fleet_placements p JOIN releases r ON r.id = p.release_id
      WHERE p.node = $1 AND p.state = 'starting'`,
    [node],
  )).rows.map((r) => ({ slug: r.slug as string, instance: Number(r.instance), image: r.image as string }));
  if (!rows.length) return 0;

  const ready = readyInstances(rows, confirmed);
  for (const r of ready) {
    await pool.query(
      `UPDATE fleet_placements SET state = 'ready' WHERE slug = $1 AND instance = $2 AND state = 'starting'`,
      [r.slug, r.instance],
    );
  }
  // A promotion changes what the reconciler will do next pass, and the edge
  // routes on ready placements — so both need to know without waiting.
  if (ready.length) await bumpFleetGeneration();
  return ready.length;
}

/* -------------------------------------------------------------------------- */
/* The loop's own state, because a loop that lies about itself is the worst     */
/* kind.                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * How long a pass may go without succeeding before that is a fault.
 *
 * The scheduler calls every minute, so five is five missed chances — long
 * enough that a bad minute is not an alarm, short enough that the forty minutes
 * this exists because of would have been caught in five.
 */
const STALE_AFTER_MS = 5 * 60_000;

export interface PassRecord {
  lastAttemptAt: number;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  lastError: string | null;
}

/**
 * Is the reconciler actually reconciling?
 *
 * THE FAILURE THIS EXISTS FOR: it errored on every pass for forty minutes and
 * nothing noticed, because a loop that throws and a loop with nothing to do both
 * answer "no steps". That is the same absent-versus-empty distinction this
 * codebase enforces on the wire — `ProcessState`, `BuildsWindow`, `who` — made
 * wrongly by the loop about itself.
 *
 * Two different unhealthy states, deliberately not collapsed. A loop that is
 * FAILING is a bug in the pass; a loop that has not been CALLED is a scheduler
 * that stopped, a job someone disabled, a trigger a deploy removed. They look
 * identical in a "last success" timestamp and want completely different next
 * moves, so they are told apart here rather than left to whoever reads it.
 *
 * Never run at all is not a fault. That is a fresh environment, and reporting
 * absence of history as breakage would make every new one look broken.
 */
export function reconcileHealth(
  r: PassRecord | null,
  now: number,
): { healthy: boolean; reason?: string } {
  if (!r) return { healthy: true, reason: "the reconciler has never run here" };
  if (now - r.lastAttemptAt > STALE_AFTER_MS) {
    return {
      healthy: false,
      reason: `the reconciler has not been called for ${Math.round((now - r.lastAttemptAt) / 1000)}s — the schedule, not the pass`,
    };
  }
  if (r.lastSuccessAt === null || now - r.lastSuccessAt > STALE_AFTER_MS) {
    return {
      healthy: false,
      reason: `the reconciler has not completed a pass for ${
        r.lastSuccessAt === null ? "as long as it has been called" : `${Math.round((now - r.lastSuccessAt) / 1000)}s`
      } — ${r.consecutiveFailures} consecutive failures, last: ${r.lastError ?? "unknown"}`,
    };
  }
  return { healthy: true };
}

let passEnsured: Promise<void> | null = null;
function ensurePassTable(): Promise<void> {
  if (!passEnsured) {
    passEnsured = getPool(DB)
      .query(
        `CREATE TABLE IF NOT EXISTS fleet_reconcile (
           only_row             boolean PRIMARY KEY DEFAULT true,
           last_attempt_at      timestamptz NOT NULL DEFAULT now(),
           last_success_at      timestamptz,
           consecutive_failures int NOT NULL DEFAULT 0,
           last_error           text,
           CONSTRAINT fleet_reconcile_one_row CHECK (only_row)
         )`,
      )
      .then(() => undefined)
      .catch((e) => { passEnsured = null; throw e; });
  }
  return passEnsured;
}

/** Record how a pass went. Never throws: the loop's diary must not stop the loop. */
export async function recordPass(ok: boolean, error?: string): Promise<void> {
  try {
    await ensurePassTable();
    await getPool(DB).query(
      `INSERT INTO fleet_reconcile (only_row, last_attempt_at, last_success_at, consecutive_failures, last_error)
         VALUES (true, now(), CASE WHEN $1 THEN now() END, CASE WHEN $1 THEN 0 ELSE 1 END, $2)
       ON CONFLICT (only_row) DO UPDATE SET
         last_attempt_at = now(),
         last_success_at = CASE WHEN $1 THEN now() ELSE fleet_reconcile.last_success_at END,
         consecutive_failures = CASE WHEN $1 THEN 0 ELSE fleet_reconcile.consecutive_failures + 1 END,
         last_error = $2`,
      [ok, error ?? null],
    );
  } catch (e) {
    console.error("reconcile: could not record the pass", e instanceof Error ? e.message : String(e));
  }
}

/** The loop's own state, or null if it has never run here. */
export async function passRecord(): Promise<PassRecord | null> {
  try {
    await ensurePassTable();
    const r = await getPool(DB).query(
      `SELECT extract(epoch from last_attempt_at) * 1000 AS a,
              extract(epoch from last_success_at) * 1000 AS s,
              consecutive_failures AS f, last_error AS e
         FROM fleet_reconcile WHERE only_row`);
    const row = r.rows[0];
    if (!row) return null;
    return {
      lastAttemptAt: Number(row.a),
      lastSuccessAt: row.s === null ? null : Number(row.s),
      consecutiveFailures: Number(row.f),
      lastError: row.e ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Converge ONE app now, instead of waiting for the next scheduled pass.
 *
 * A deploy writes `apps.desired_release` and then wants the placement to happen
 * immediately — waiting up to a minute for the tick would put the whole
 * reconcile interval on the front of every deploy. It takes the same advisory
 * lock, so a deploy and the scheduled pass cannot act on the fleet at once.
 *
 * Null means another pass holds the lock. That is not an error and not a
 * failure to converge: the pass already running will see this app's new desired
 * release, because it reads the row rather than a snapshot taken before.
 */
export function convergeApp(slug: string, now: number = Date.now()): Promise<PassResult | null> {
  return reconcileOnce(now, slug);
}
