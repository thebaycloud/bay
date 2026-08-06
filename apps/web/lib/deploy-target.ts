import { runtimeOf, type Runtime } from "./fleet";
import { CLOUD_RUN_DB, FLEET_DB, type DbAddress } from "./db-address";

/**
 * Deploy target: where an app's processes end up running. See CONTEXT.md.
 *
 * Today that question is a boolean re-read at 21 separate places — 16 inside
 * deploy-pipeline.ts (`toFleet`) and 5 more API routes that independently
 * recompute `runtimeOf(slug) === "fleet"` — none sharing an accessor. Two of
 * those 21 needed to ask a question they never did (see `supports` below) and
 * shipped live bugs as a result. This module is the one place that answer
 * lives, so the next site that needs it asks once instead of re-deriving it.
 *
 * Nothing here is wired to a call site yet. Every one of the 21 keeps
 * re-deriving its own answer exactly as before — this exists beside them,
 * proven by tests, so migrating one at a time (a later ticket) has somewhere
 * to move to.
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
 * - `domainMapping` and `autoRollbackOnFailure` are NOT refused anywhere
 *   today. `deploy-pipeline.ts`'s domain-mapping branch and its own
 *   rollback-on-failure safety net both run unconditionally and fail
 *   silently for a fleet app — see docs/research/cloud-run-shape.md, "the
 *   gap". They're listed here at their true value so that guarding them
 *   later is a one-line `if (!target.supports(...))`, not a new investigation.
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
 * struct drifted silently). Moving call sites onto a shared implementation is
 * for the tickets that follow; this one only names the seam.
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
   * row, or folded into the app's startup with no row at all. False here is
   * why a reliability read of `deploy_stages` is Cloud-Run-only by
   * construction today, silently — see docs/research/cloud-run-shape.md §3.
   */
  readonly hasReleaseStage: boolean;

  /** Whether this target can do `capability` today. False is a fact, not a TODO. */
  supports(capability: DeployCapability): boolean;
}

const CAPABILITIES: Record<Runtime, ReadonlySet<DeployCapability>> = {
  cloudrun: new Set<DeployCapability>(["exec", "rollback", "domainMapping", "autoRollbackOnFailure"]),
  // Empty, not partially filled: nothing on this list works for a fleet app
  // today, whether or not the code currently agrees with that (see the two
  // bugs above).
  fleet: new Set<DeployCapability>(),
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
  hasReleaseStage: false,
  supports: (capability) => CAPABILITIES.fleet.has(capability),
};

/** The target for a runtime value already in hand — e.g. from `apps.runtime`. */
export function deployTargetFor(kind: Runtime): DeployTarget {
  return kind === "fleet" ? FLEET_TARGET : CLOUD_RUN_TARGET;
}

/**
 * The target an app is on right now. The read-and-branch every one of the 5
 * API-route sites does inline (`runtimeOf(slug) === "fleet"`), collapsed to
 * one call — not used by any of them yet, so today's behavior is untouched.
 */
export async function deployTargetForApp(slug: string): Promise<DeployTarget> {
  return deployTargetFor(await runtimeOf(slug));
}
