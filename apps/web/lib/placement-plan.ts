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
  /**
   * How many placements this node is carrying, fleet-wide.
   *
   * Passed in rather than counted here for the same reason the ORDER is: which
   * node is least loaded is a fact about every app, and this function sees one.
   */
  load: number;
}

/**
 * How much emptier another node must be before an app is moved to it.
 *
 * Two, and the number is the whole defence against oscillation. Moving an app to
 * correct a difference of ONE creates the mirror image of that difference, which
 * a rebalancer then corrects by moving it back, forever. At two the move leaves
 * the fleet strictly closer to level and there is nothing left to correct.
 */
const REBALANCE_GAP = 2;

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
  /**
   * Whether this app may be rebalanced on this pass.
   *
   * ONE APP PER PASS, and the budget has to live in the CALLER because that is
   * where the loop is. This function returning a single step was never enough:
   * `pass` calls it once per app, every app sees the same load snapshot taken at
   * the start of the pass, and so every app on the fullest node decides to move
   * at once.
   *
   * Watched happen in production the moment a rebuilt node registered: nineteen
   * apps placed a second instance on it in one pass, the loads swung from 13/19/0
   * to 13/19/32, and the next pass did it again in the other direction. A
   * rebalancer that acts on a snapshot it is invalidating is not converging, it
   * is ringing.
   */
  mayRebalance = true,
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

  const draining = placements.filter((p) => p.state === "draining");
  if (draining.length) {
    return draining.map((p) => ({ kind: "remove" as const, slug, instance: p.instance }));
  }

  // More instances than were asked for. Production had this and the planner did
  // not: `placeApp` upserts on (slug, node), so a deploy that chose a different
  // node from the last one wrote a SECOND row rather than moving the first, and
  // `placementFor` reads with LIMIT 1 — so nothing in the code ever saw it.
  // fleet-place.ts had already named the shape: "two copies of the app running
  // at once, which is exactly what this sequence exists to prevent."
  //
  // THE FULLEST NODE LOSES ITS COPY, which is what completes a rebalance. This
  // used to keep the lowest-numbered instances, and the reason given was
  // stability: "a rule that picked by node or by age could pick differently on
  // the next pass and remove the one it had just decided to keep."
  //
  // That danger is real and this ordering answers it. Load is the primary key
  // and the instance number is the tie-break, so two nodes carrying the same
  // amount fall back to exactly the old rule — deterministic — while a genuine
  // imbalance resolves the same way every pass until it is gone. Keeping the
  // lowest instance instead would undo every rebalance the moment it was made,
  // moving an app back and forth forever.
  if (wanted.length > desired.replicas) {
    const loadOf = new Map(nodes.map((n) => [n.name, n.load]));
    return wanted
      .slice()
      .sort((a, b) => (loadOf.get(b.node) ?? 0) - (loadOf.get(a.node) ?? 0) || b.instance - a.instance)
      .slice(0, wanted.length - desired.replicas)
      .map((p) => ({ kind: "remove" as const, slug, instance: p.instance }));
  }

  if (stale.length && ready >= desired.replicas) {
    return stale.map((p) => ({ kind: "drain" as const, slug, instance: p.instance }));
  }

  // REBALANCING, and it is last on purpose: everything above is the fleet not
  // being what it should be, and this is the fleet being right but lopsided.
  // Nothing here runs while there is real work outstanding.
  //
  // The fleet used to level out only as new apps arrived. After a node failure
  // and its recovery one machine sat empty while another carried nineteen, and
  // no pass would ever have moved one back.
  //
  // Every guard below is a way this could do harm rather than good:
  //   - no quorum, no move. The loads being balanced against are read from the
  //     fleet, and a control plane that cannot see it is balancing against stale
  //     numbers.
  //   - pinned apps never move. Their data is on one machine and nothing
  //     replicates it; tidiness is the worst possible reason to leave it behind.
  //   - only a placement that is READY. Mid-deploy the loads are still moving,
  //     and moving an app that has not finished arriving abandons a pull that is
  //     already half done.
  //   - one app per pass, because this returns as soon as it acts. The next pass
  //     sees the fleet the move produced rather than the one it started from.
  //
  // BESIDE, never instead: this emits a `place` on the emptier node while the app
  // goes on serving where it is, and the trim above completes the move on a later
  // pass — after the new instance exists.
  if (mayRebalance && quorum && desired.pinnedTo === null && wanted.length === desired.replicas && ready === desired.replicas) {
    const healthyNodes = nodes.filter((n) => n.healthy);
    const taken = new Set(placements.map((p) => p.node));
    const emptiest = healthyNodes.filter((n) => !taken.has(n.name)).sort((a, b) => a.load - b.load)[0];
    const fullest = wanted
      .map((p) => healthyNodes.find((n) => n.name === p.node))
      .filter((n): n is NodeHealth => Boolean(n))
      .sort((a, b) => b.load - a.load)[0];
    if (emptiest && fullest && fullest.load - emptiest.load >= REBALANCE_GAP) {
      const used = new Set(placements.map((p) => p.instance));
      let instance = 0;
      while (used.has(instance)) instance++;
      return [{ kind: "place", slug, instance, node: emptiest.name, release: desired.release }];
    }
  }

  return [];
}
