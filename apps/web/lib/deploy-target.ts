import { runtimeOf, type Runtime } from "./fleet";
import { CLOUD_RUN_DB, FLEET_DB, type DbAddress } from "./db-address";

/**
 * Deploy target: where an app's processes end up running. See CONTEXT.md.
 *
 * When this module was written, that question was a boolean re-read at 21
 * separate places with no shared accessor: 16 inside deploy-pipeline.ts
 * (`toFleet`) and 5 more API routes that independently recomputed
 * `runtimeOf(slug) === "fleet"`. Two of those 21 needed to ask a question
 * they never did (see `supports` below) and shipped live bugs as a result.
 * This module is the one place that answer lives, so the next site that
 * needs it asks once instead of re-deriving it.
 *
 * Migrated onto it since: all 5 API-route sites (48af6bc) — exec, env
 * (twice), the app route and rollback now call `deployTargetForApp` once and
 * branch on `.kind` or `.supports(...)` — and, inside the pipeline, the two
 * capability questions this module exists for: `domainMapping` (f50143b) and
 * `autoRollbackOnFailure` (deploy-pipeline.ts:3926).
 *
 * NOT migrated: `toFleet` itself. deploy-pipeline.ts still computes it once
 * (:2232) and branches on it directly at roughly a dozen more sites, but
 * every one of those asks WHICH FUNCTION to call or WHICH STRING to write
 * (`runFleetDeploy` vs `runDeploy`, `"fleet"` vs `"cloudrun"` for
 * `apps.runtime`) — a routing decision `.kind` already answers, not a yes/no
 * capability `supports(...)` was built for. Collapsing those onto `.kind` is
 * its own later ticket (#14, named when the API routes migrated) — this
 * module has had somewhere for that migration to land since it was written,
 * whether or not anything has taken it yet.
 */

/**
 * A thing a target either can or cannot do for a given app, independent of
 * that app's own code. Four values, because four is exactly how many of the
 * 21 sites asked a yes/no question shaped like this rather than "which value"
 * or "which function":
 *
 * - `exec` and `rollback` are refused outright, at the API
 *   (app/api/apps/[slug]/exec/route.ts, .../rollback/route.ts) — there is no
 *   per-app job image to exec into, and a placement holds one spec, not a
 *   history to roll back to.
 * - `domainMapping` and `autoRollbackOnFailure` used to run unconditionally
 *   and fail silently for a fleet app — `deploy-pipeline.ts`'s domain-mapping
 *   branch and its own rollback-on-failure safety net, see
 *   docs/research/cloud-run-shape.md, "the gap". Both are guarded by
 *   `target.supports(...)` at their call sites now (:4248 and :3926) — the
 *   one-line change this list was listing them for. Kept here rather than
 *   folded away now that the gap is closed: the guard reads `supports(...)`
 *   because this type says these are refusable facts, not because someone
 *   remembered to add an `if`.
 *
 * Not the ADR's full list of lost capabilities (traffic splitting,
 * scale-to-zero, IAM-scoped auth) — those are real, but no call site asks
 * about them today, and a value nothing reads yet is a guess, not a finding.
 */
export type DeployCapability = "exec" | "rollback" | "domainMapping" | "autoRollbackOnFailure";

/**
 * The facts that follow from which target an app is on, not from the app
 * itself. Deliberately not deploy/describe/exec methods: those live deep
 * inside deploy-pipeline.ts and gcloud.ts, behind closures (`runDeploy`,
 * `runFleetDeploy`) that are not even exported. Reimplementing them here
 * would be a second copy to keep in sync by hand — the exact failure mode
 * fleet-spec.ts's own doc comment already reports once (the agent's `App`
 * struct drifted silently). Moving call sites onto a shared implementation
 * started with the 5 API routes and the two `supports(...)` guards named in
 * the module doc above; deploy/describe/exec staying out of here is still
 * true of all of them.
 */
export interface DeployTarget {
  /** "cloudrun" | "fleet" — the value already stored in `apps.runtime`. */
  readonly kind: Runtime;

  /** Where this target's apps reach Postgres. See lib/db-address.ts. */
  readonly databaseAddress: DbAddress;

  /**
   * Whether this target starts and stops an app's non-web processes itself.
   * True means the pipeline must not also manage them through Cloud Run's
   * worker-pool/cron-job primitives (`deploy-pipeline.ts`'s
   * `FLEET_OWNS_PROCESSES`) — deploying both leaves two owners disagreeing
   * about whether a worker exists, and the pipeline's own orphan sweep would
   * delete the one Cloud Run owns while the node runs the other.
   */
  readonly ownsProcessLifecycle: boolean;

  /**
   * Whether "release" is its own pipeline stage with its own `deploy_stages`
   * row, or folded into the app's startup with no row at all. Both targets
   * answer true today: a reliability read of `deploy_stages` used to be
   * Cloud-Run-only by construction, silently — see
   * docs/research/cloud-run-shape.md §3 — until `deploy-pipeline.ts` started
   * writing a real `release` row for a fleet deploy too (:3755), the same
   * `stages.start("release")` shape its Cloud Run branch already used (:2759),
   * each one only when the app actually declares a release process. Kept as
   * its own field rather than deleted now that both agree: the fact it
   * records is a property of the TARGET, not a coincidence of the two that
   * happen to exist, and the next one is not guaranteed to have it.
   */
  readonly hasReleaseStage: boolean;

  /** Whether this target can do `capability` today. False is a fact, not a TODO. */
  supports(capability: DeployCapability): boolean;
}

const CAPABILITIES: Record<Runtime, ReadonlySet<DeployCapability>> = {
  // `rollback` is GONE from this one, and that is the same change as adding it
  // below. Cloud Run's rollback was `gcloud run revisions list` and a traffic
  // split back to the last Ready one; the container lane it belonged to is
  // deleted, and the only apps still on this target are static — files in a
  // bucket, which have no revisions to walk. What is left here guards static.
  cloudrun: new Set<DeployCapability>(["exec", "domainMapping", "autoRollbackOnFailure"]),
  // `rollback` is here now, and it is the first entry this set has ever had.
  //
  // It was empty with the note "nothing on this list works for a fleet app
  // today", and that stayed true only as long as a placement kept one spec and
  // no history. `releases` records every version with the spec that shipped,
  // `fleet_placements` copies that spec byte-for-byte, and `planPlacements`
  // converges on whatever `desired_release` names without caring whether it is
  // newer or older than what is running. So rolling back is one write and the
  // reconciler performs it — through the same function a deploy uses.
  //
  // The rest stay off, and each is still a fact rather than a TODO: `exec` has
  // no per-app isolated execution on a node, `domainMapping` points at a Cloud
  // Run service, and `autoRollbackOnFailure` is Cloud Run's traffic-split undo,
  // which is a different mechanism from this one — a failed fleet deploy is
  // handled by `placeOnFleet` restoring the previous placement, not by walking a
  // revision history.
  fleet: new Set<DeployCapability>(["rollback"]),
};

/** cloudrun: unchanged from before this module existed. */
export const CLOUD_RUN_TARGET: DeployTarget = {
  kind: "cloudrun",
  databaseAddress: CLOUD_RUN_DB,
  ownsProcessLifecycle: false,
  hasReleaseStage: true,
  supports: (capability) => CAPABILITIES.cloudrun.has(capability),
};

/** fleet: the node owns everything Cloud Run's per-app primitives used to. */
export const FLEET_TARGET: DeployTarget = {
  kind: "fleet",
  databaseAddress: FLEET_DB,
  ownsProcessLifecycle: true,
  hasReleaseStage: true,
  supports: (capability) => CAPABILITIES.fleet.has(capability),
};

/** The target for a runtime value already in hand — e.g. from `apps.runtime`. */
export function deployTargetFor(kind: Runtime): DeployTarget {
  return kind === "fleet" ? FLEET_TARGET : CLOUD_RUN_TARGET;
}

/**
 * The target an app is on right now. What the 5 API-route sites used to do
 * inline (`runtimeOf(slug) === "fleet"`, one recompute per site), collapsed
 * to one call — and, since 48af6bc, the one they actually make: exec, env
 * (twice), the app route and rollback all resolve their target through here
 * now instead of re-deriving it.
 */
export async function deployTargetForApp(slug: string): Promise<DeployTarget> {
  return deployTargetFor(await runtimeOf(slug));
}
