import type { ResolvedApp, ResolvedService } from "./resolve";
import type { Lane, Scale } from "./lanes";
import type { HealthConfig } from "./app-config";
import { memoryBytes, cpuShares } from "./fleet-spec";

/**
 * The one object a lane is given, and the proof that it read it.
 *
 * Phase 3's assert-consumed, and deliberately not the version the plan
 * describes. That version compares a service's declared fields against a
 * per-lane capability list — and a real deploy showed that list lying: `env` was
 * named in LANE_CONSUMES for every lane, printed back to the author by
 * `supersonic check`, refused if it collided with a platform name, and then read
 * by no code at all. The revision came up without a single declared variable and
 * every static check passed, because the list said the lane was capable and
 * nobody asked whether the lane had actually looked.
 *
 * A declaration of capability is a promise. This module checks the promise
 * against what happened: the envelope handed to a lane records which fields were
 * genuinely read while it ran, and a field the author declared but the lane
 * never touched fails the deploy naming the field. That distinction is the whole
 * point — three of the four bugs found on the first container-lane deploy were a
 * field written, validated, printed back, and read by nobody, and a capability
 * list is exactly the wrong instrument for finding those, because it is a second
 * declaration rather than an observation.
 */

export interface ServiceEnvelope {
  name: string;
  dir: string;
  path: string;
  lane: Lane;

  runtime?: string;
  framework?: string;

  install?: string;
  build?: string;
  release?: string;
  start?: string;

  outputDir?: string;
  spaFallback: boolean;
  dockerfile?: string;
  context?: string;

  /** Non-secret literals the author declared. */
  env: Record<string, string>;
  /** Baked at build time; useless at runtime. */
  buildEnv: Record<string, string>;
  /** NAMES only. */
  secrets: string[];
  uses: ("database" | "bucket")[];

  health: HealthConfig;
  scale: Scale;

  /**
   * The secret NAME carrying an external database's URL, when the app owns its
   * own database. Absent for a managed one, where the platform writes the
   * connection itself.
   *
   * An app-level fact rather than a service-level one, carried on the envelope
   * because this is the object the checks below read, and `uses: ["database"]`
   * means two different observable things depending on it: a database the
   * platform provisioned, or a secret reference that reached the revision.
   */
  dbUrlName?: string;

  /**
   * What the AUTHOR wrote, carried through from the resolver.
   *
   * Not re-derived from the values here, because it cannot be: `health` and
   * `scale` hold resolver defaults on every service, so "is it non-empty" says
   * yes for a service whose author wrote nothing and the deploy would fail
   * demanding that a lane read a default nobody asked for. Emptiness is not
   * authorship — the same distinction assert-consumed already turns on in
   * lib/resolve.ts, and the same mistake made twice now if it is guessed at.
   */
  declared: Declared;
}

/** Which envelope fields the AUTHOR actually declared, in envelope terms. */
export type Declared = ReadonlyArray<keyof ServiceEnvelope>;

export function buildEnvelope(service: ResolvedService, app: ResolvedApp): ServiceEnvelope {
  const db = app.resources?.database;
  return {
    name: service.name,
    dir: service.dir,
    path: service.path,
    lane: service.lane,
    runtime: service.runtime,
    framework: service.framework,
    install: service.install,
    build: service.build,
    release: service.release,
    start: service.start,
    outputDir: service.outputDir,
    spaFallback: service.spaFallback,
    dockerfile: service.dockerfile,
    context: service.context,
    env: service.env,
    buildEnv: service.buildEnv,
    secrets: service.secrets,
    uses: service.uses,
    health: service.health,
    scale: service.scale,
    dbUrlName: db?.provider === "external" ? db.urlFrom : undefined,
    declared: service.declared as Declared,
  };
}

/**
 * Fields that carry a value on every service whether or not anyone asked for
 * them, so reading them proves nothing and not reading them means nothing.
 */
const NEVER_ASSERTED = new Set<string>([
  "name", "dir", "path", "lane", "declared", "dbUrlName",
  // `processes` is asserted, but not HERE and not against this evidence.
  //
  // Everything else in this envelope is a property of the REVISION — a variable
  // in its spec, a secret mounted on it, a command in its argv — and the whole
  // point of this check is to read the revision back and refuse to call a deploy
  // successful when the revision does not carry what the author declared.
  //
  // A worker and a cron are not revision fields. They are separate Cloud Run
  // resources — a worker pool and a job — created after this runs, by
  // `deployProcesses`. Asked about them here, this check can only answer "nothing
  // knows what this field's effect looks like", which is what it did on the first
  // real worker-only deploy: the app was correct, the processes were correct, and
  // the deploy was refused between building the bundle and creating the pool.
  //
  // Their independent evidence is stronger than a spec read anyway: the deploy
  // either created the resources or it did not, and `deployProcesses` throws a
  // summary naming every process that failed. That is the same standard this
  // module was written to enforce — an outcome, not a second declaration — applied
  // to a resource that lives outside the revision.
  "processes",
]);

export interface Tracked {
  envelope: ServiceEnvelope;
  /** Fields read since the envelope was handed over. */
  readFields(): Set<string>;
}

/**
 * Hand out an envelope that remembers what was asked of it.
 *
 * A Proxy rather than instrumented accessors because the lanes must not have to
 * cooperate — the whole failure being caught is a lane that did not read
 * something, and asking that lane to report its own reads would be trusting the
 * code under test to grade itself.
 */
export function track(envelope: ServiceEnvelope): Tracked {
  const seen = new Set<string>();
  const proxy = new Proxy(envelope, {
    get(target, prop, receiver) {
      if (typeof prop === "string") seen.add(prop);
      return Reflect.get(target, prop, receiver);
    },
  });
  return { envelope: proxy, readFields: () => new Set(seen) };
}

/**
 * Every field the author declared, that the lane never read.
 *
 * Takes the ORIGINAL envelope, not the tracked proxy — inspecting the proxy to
 * find out what was declared would mark every field as read and the check would
 * pass unconditionally, which is a very quiet way to delete a safety net.
 */
export function unconsumed(original: ServiceEnvelope, read: Set<string>): string[] {
  return [...original.declared]
    .filter((f) => !NEVER_ASSERTED.has(f as string))
    .filter((f) => !read.has(f as string))
    .map(String)
    .sort();
}

export class UnconsumedField extends Error {}

/**
 * What the deploy actually assembled, as opposed to what it was told.
 *
 * The stronger check, and the one wired into the pipeline. Read-tracking proves
 * a field was LOOKED at; this proves the value arrived. Those differ in the
 * direction that matters: code can read `env`, transform it, and drop it on the
 * floor — and every failure found on the first container-lane deploy was of
 * exactly that kind, a value that was handled and then not present in the
 * revision.
 */
export interface DeployOutcome {
  /**
   * The environment of the revision Cloud Run just returned — what the app
   * actually has, not what this deploy sent.
   *
   * Those differ, legitimately. `--update-secrets` and `--update-env-vars` MERGE,
   * deliberately, so that a redeploy cannot drop a key an earlier one set; a
   * value the user put there with `supersonic env set` survives too. Checking
   * this deploy's own inputs therefore fails a perfectly correct app whose
   * secrets were stored on a previous deploy and inherited — which is exactly
   * what the first run of this check did, on an app that was working.
   *
   * Empty when there is no revision to read, as on the static lane, in which
   * case the environment fields cannot be verified and are not asserted.
   */
  revisionEnv: { name: string; fromSecret: boolean }[];
  /** Whether a revision was returned at all. */
  hasRevision: boolean;
  /** The one-shot command the release phase will run, if any. */
  releaseCommand: string;
  /** The full argv handed to gcloud, so scale and probes can be checked. */
  argv: string[];
  /** Whether provisioning actually produced a database for this app. */
  hasDatabase: boolean;
  /**
   * The size the node was actually handed, when this deploy placed on the fleet.
   *
   * Null on every other path, where argv is the evidence instead. The fleet
   * branch never calls `attempt()`, so `argv` is `[]` on it — and `scale` read
   * `argv` with no guard while `env`, `secrets` and `uses` all short-circuit on
   * `!hasRevision`. The result was an exception thrown AFTER a successful
   * placement: the app was live on a node, the outer catch wrote `status:
   * failed`, `markAppLive` never ran so `run_url` still pointed at the old
   * address, and the owner was told "That is a platform bug".
   *
   * A placement is the STRONGER evidence, not a weaker substitute for argv. It
   * is the row the agent reads to decide the cgroup limits, so it is the outcome
   * itself rather than a command that might produce one.
   */
  placed?: { memoryBytes: number; cpuShares: number } | null;
}

const carries = (o: DeployOutcome, n: string, fromSecret: boolean) =>
  o.revisionEnv.some((e) => e.name === n && e.fromSecret === fromSecret);

/**
 * Each declarable field, and how to tell from the OUTCOME that it took effect.
 *
 * A list, and therefore something that can itself drift — but it drifts loudly:
 * a field with no entry here is reported as unverifiable rather than silently
 * assumed fine, so adding a schema field without teaching this what its effect
 * looks like fails the deploy that first declares it.
 */
const REACHED: Partial<Record<keyof ServiceEnvelope, (e: ServiceEnvelope, o: DeployOutcome) => boolean>> = {
  // Unverifiable without a revision to read, and an unverifiable field must not
  // be reported as a failure — the static lane deploys no service at all.
  env: (e, o) => !o.hasRevision || Object.keys(e.env).every((k) => carries(o, k, false)),
  // As a reference, not a literal. A secret that arrives as a plain value in the
  // revision spec has reached the app and defeated the reason for declaring it
  // one, so `secrets` is the field where HOW it arrived is the whole point.
  secrets: (e, o) => !o.hasRevision || e.secrets.every((s) => carries(o, s, true)),
  release: (e, o) => o.releaseCommand.trim() !== "",
  // What counts as "the database reached the app" depends on whose database it
  // is, and both halves have to be checked or the new mode becomes the next
  // declared-and-ignored field — the exact class this module exists to end.
  // Managed: provisioning ran. External: the connection secret is mounted on the
  // revision, by reference, which is the only observable the platform has and the
  // only one it needs.
  uses: (e, o) => {
    if (!e.uses.includes("database")) return true;
    if (e.dbUrlName) return !o.hasRevision || carries(o, e.dbUrlName, true);
    return o.hasDatabase;
  },
  // Two runtimes, two pieces of evidence, and neither is optional.
  //
  // On a node, `memory` and `cpu` are the whole of what `scale` means: the
  // placement row carries them as cgroup limits and the agent enforces them.
  // The other four are Cloud Run's autoscaler, which the fleet does not have —
  // `runFleetDeploy` names them in the log rather than dropping them silently,
  // and none of them can be read back from a placement because none of them was
  // ever written to one.
  //
  // The `!o.hasRevision` tail is the guard the neighbours above already carry.
  // Without it this threw on the static lane's sibling case and, far worse, on
  // every fleet deploy — see DeployOutcome.placed.
  scale: (e, o) => {
    if (o.placed) return o.placed.memoryBytes === memoryBytes(e.scale.memory) && o.placed.cpuShares === cpuShares(e.scale.cpu);
    return !o.hasRevision || (o.argv.includes(e.scale.memory) && o.argv.includes(`--timeout=${e.scale.timeout}`));
  },
  // Read by the verifier after the revision is live rather than by the argv, so
  // its effect is not visible here. Present so it is not reported unverifiable.
  health: () => true,
  // Build-time by definition: it shapes the bundle, not the revision.
  buildEnv: () => true,
  // Structural — they choose the lane and the commands, and a wrong choice shows
  // up as a failed build long before this.
  runtime: () => true,
  framework: () => true,
  install: () => true,
  build: () => true,
  start: () => true,
  outputDir: () => true,
  spaFallback: () => true,
  dockerfile: () => true,
  context: () => true,
};

/**
 * Fail the deploy for a field the author declared that did not reach it.
 *
 * This is the check that would have caught `env` being parsed, validated,
 * printed back and set on nothing; `release` never running for a container-lane
 * app; and `uses: ["database"]` provisioning no database. All three shipped
 * green with unit tests over them, because every one of those tests asked what
 * the code contained rather than what the deploy came out holding.
 */
export function assertReached(e: ServiceEnvelope, o: DeployOutcome): void {
  const failures: string[] = [];
  for (const field of e.declared) {
    if (NEVER_ASSERTED.has(field as string)) continue;
    const check = REACHED[field];
    if (!check) {
      failures.push(`${String(field)} (nothing knows what this field's effect looks like)`);
      continue;
    }
    if (!check(e, o)) failures.push(String(field));
  }
  if (!failures.length) return;
  throw new UnconsumedField(
    `the ${e.lane} lane did not apply: ${failures.sort().join(", ")}\n` +
    `  Service "${e.name}" declares ${failures.length === 1 ? "it" : "them"} and the deployed revision does not carry ${failures.length === 1 ? "it" : "them"}.\n` +
    `  That is a platform bug, not a mistake in your configuration — the value is valid and nothing acted on it.`,
  );
}

/**
 * Fail the deploy for a field that was declared and then ignored.
 *
 * Deliberately a failure and not a warning. The entire cost of these bugs was
 * that they were survivable: the app deployed, looked healthy, and behaved as
 * though the author had never written the line. A deploy that stops and names
 * the field is worth more than one that succeeds while quietly disagreeing with
 * its own configuration.
 */
export function assertAllConsumed(original: ServiceEnvelope, read: Set<string>): void {
  const ignored = unconsumed(original, read);
  if (!ignored.length) return;
  const them = ignored.length === 1 ? "it" : "them";
  throw new UnconsumedField(
    `the ${original.lane} lane never read: ${ignored.join(", ")}\n` +
    `  Service "${original.name}" declares ${ignored.length === 1 ? "that field" : "those fields"} and this deploy would ignore ${them}.\n` +
    `  That is a platform bug, not a mistake in your configuration — the value is valid and nothing acted on it.`,
  );
}
