/**
 * What should change about where an app runs — decided, not performed.
 *
 * Pure, and that is the point. `lib/process-plan.ts` already established the
 * split this follows: "every decision is made by the pure planner and every
 * argv by lib/process-deploy.ts, so what is left is a loop — the risk lives in
 * about thirty lines and the rules stay under test."
 *
 * The rules here are the ones that are expensive to get wrong: a rollout that
 * removes before it places is downtime, and an eviction that fires during a
 * partition is two copies of an app writing to one database. Neither is
 * something to discover in production, and neither needs a database to test.
 *
 * ONE STEP PER PASS, deliberately. The planner could return a whole rollout at
 * once and the reconciler could execute it, but then the plan would be acting on
 * a picture of the fleet that is already out of date by its second step. Each
 * pass looks at what is true now and moves one thing; convergence is the loop's
 * job, not the plan's.
 */

export interface Desired {
  slug: string;
  /** Which release should run, or null when the app should not run at all. */
  release: number | null;
  replicas: number;
  /**
   * The node this app cannot leave, or null.
   *
   * A volume is bind-mounted from one machine's disk and nothing replicates it
   * (see the architecture spec §8), so moving such an app separates it from its
   * data. The model has to be able to say this; the reconciler has to respect it.
   */
  pinnedTo: string | null;
}

export interface Placed {
  instance: number;
  node: string;
  release: number;
  state: "starting" | "ready" | "draining";
  /** Epoch millis. Past means the control plane MAY re-place — not that the node stops. */
  leaseUntil: number;
}

export interface NodeHealth {
  name: string;
  healthy: boolean;
}

export type Step =
  | { kind: "place"; slug: string; instance: number; node: string; release: number }
  | { kind: "drain"; slug: string; instance: number }
  | { kind: "remove"; slug: string; instance: number }
  | { kind: "evict"; slug: string; instance: number };

/**
 * @param nodes      Healthy-first is not required, but ORDER IS HONOURED: the
 *                   planner spreads one app across nodes, and the caller —
 *                   which knows what the whole fleet is carrying — decides
 *                   which node is least loaded by passing them in that order.
 *                   Two spreading rules in one function would be one too many.
 * @param quorum     Whether the control plane can see enough of the fleet to be
 *                   sure it is not the isolated party. False forbids eviction
 *                   entirely, however long a node has been silent.
 */
export function planPlacements(
  desired: Desired,
  placements: Placed[],
  nodes: NodeHealth[],
  now: number,
  quorum: boolean,
): Step[] {
  const { slug } = desired;

  // Not wanted anywhere. Every instance goes, and nothing else is considered —
  // placing and removing in one pass would be two opinions about the same app.
  if (desired.release === null) {
    return placements.map((p) => ({ kind: "remove" as const, slug, instance: p.instance }));
  }

  const healthy = new Set(nodes.filter((n) => n.healthy).map((n) => n.name));

  // Eviction first, and alone. An instance whose lease has expired on a node we
  // cannot hear is a placement the control plane has the right to take back —
  // but only if it can see the rest of the fleet, and only if the app is free to
  // move. Returning here rather than also placing is deliberate: placing in the
  // same pass would put the replacement down before the eviction had taken
  // effect, which is the two-copies hazard arriving through the front door.
  if (quorum && desired.pinnedTo === null) {
    const evictable = placements.filter((p) => p.leaseUntil < now && !healthy.has(p.node));
    if (evictable.length) {
      return evictable.map((p) => ({ kind: "evict" as const, slug, instance: p.instance }));
    }
  }

  const wanted = placements.filter((p) => p.release === desired.release && p.state !== "draining");
  const stale = placements.filter((p) => p.release !== desired.release);

  // Short by an instance: add one. Beside whatever is already running, never
  // instead of it.
  if (wanted.length < desired.replicas) {
    const taken = new Set(placements.map((p) => p.node));
    // Spread, for the same reason `chooseNode` refuses to bin-pack: two
    // instances of one app on one machine is one machine away from none.
    const candidates = nodes
      .filter((n) => n.healthy)
      .filter((n) => (desired.pinnedTo === null ? !taken.has(n.name) : n.name === desired.pinnedTo));
    const node = candidates[0]?.name;
    // Nowhere to put it is a fact for the caller to report, not a placement on a
    // node named undefined. `placeOnFleet` already learned this one.
    if (!node) return [];
    const used = new Set(placements.map((p) => p.instance));
    let instance = 0;
    while (used.has(instance)) instance++;
    return [{ kind: "place", slug, instance, node, release: desired.release }];
  }

  // The old release only starts going once the new one is genuinely serving.
  // `ready` and not merely placed: an instance that has been created but has not
  // answered is not cover for anything, and treating it as cover is
  // stop-then-start with extra steps.
  const ready = wanted.filter((p) => p.state === "ready").length;

  const draining = stale.filter((p) => p.state === "draining");
  if (draining.length) {
    return draining.map((p) => ({ kind: "remove" as const, slug, instance: p.instance }));
  }

  if (stale.length && ready >= desired.replicas) {
    return stale.map((p) => ({ kind: "drain" as const, slug, instance: p.instance }));
  }

  return [];
}
