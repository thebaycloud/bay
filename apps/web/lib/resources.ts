/**
 * One engine for everything the platform gives an app, on demand.
 *
 * THE PROBLEM THIS REPLACES
 *
 * `deploy-pipeline.ts` is 2598 lines with about a dozen provision-and-attach
 * operations — provisionPostgres, provisionStorage, putAppSecrets, ensureAppRole,
 * grantInvokers, grantBuildAccess, createDomainMapping, the Cloud SQL sidecar,
 * the release job, siblings, processes — each with its own condition, its own
 * ordering and its own failure handling, written at a different time. Every
 * provisioning bug in this repository is that shape:
 *
 *   - `provisionStorage` runs unconditionally, because its branch has no
 *     condition. `resources.bucket` and `uses: ["bucket"]` are both parsed and
 *     read by nothing, so every app is billed for a bucket and told in the
 *     dashboard that it has "File uploads".
 *   - The `run.googleapis.com/cloudsql-instances` annotation survives forever,
 *     because NOTHING OWNS "the set of things attached to this app" — so nothing
 *     is in a position to notice one that should not be there.
 *   - `databaseEnv` writes seventeen variable names because the database branch
 *     decides what to inject, and no other code has an opinion.
 *
 * None of those is fixable one at a time. There is no place where "what does this
 * app need" is a single value, so this module makes one:
 *
 *     declared needs  ->  desired set (pure)  ->  reconcile: attach · release
 *
 * The engine holds no proper nouns. Each resource kind is a small record
 * declaring when it is needed, what it depends on, and — the important part —
 * what happens when it stops being needed. The engine never names one.
 *
 * This is a generalisation, not a new idea: `planProcesses` + `orphans` in
 * lib/process-plan.ts is exactly this shape for two resource kinds, and it is the
 * one part of the process work that behaved correctly against real GCP on the
 * first attempt.
 */

/**
 * What happens to a resource the app no longer declares.
 *
 * THE MOST IMPORTANT TYPE IN THIS FILE, because getting it wrong destroys a
 * business rather than breaking a deploy.
 *
 * A reconciler's whole value is that it removes what is no longer wanted. Applied
 * naively here, someone deleting one line from `supersonic.json` would delete
 * their production Postgres — a company gone because of a config edit that read
 * like tidying up. So removal is a property of the KIND, declared once, never
 * decided at a call site:
 *
 *   remove  the resource is stateless and recreatable. A worker pool, a Cloud Run
 *           job, a Scheduler entry, an IAM binding, a domain mapping, a sidecar.
 *           Deleting it costs a redeploy and nothing else.
 *
 *   detach  the resource holds the customer's DATA. The app stops being told it
 *           exists — no credentials, no env, no bill for the wiring — and the
 *           bytes are left exactly where they are. Only deleting the APP deletes
 *           these, and that is a path with its own confirmation.
 *
 * "Detach" is what makes on-demand safe rather than frightening. The app stops
 * carrying STORAGE_BUCKET the moment it stops asking for a bucket; the objects
 * are still there tomorrow when someone realises they wanted it.
 */
export type Retention = "remove" | "detach";

/** What the app asked for, as facts rather than as config syntax. */
export interface Declared {
  /** Any service declared `uses: ["database"]`, or a `resources.database` block. */
  database: boolean;
  /** The app owns its database and the platform must provision nothing. */
  externalDatabase: boolean;
  /** Any service declared `uses: ["bucket"]`, or `resources.bucket`. */
  bucket: boolean;
  /** The app has at least one process that is not `web`. */
  processes: boolean;
  /** The app has a `web` process, so it has an address to route and secure. */
  web: boolean;
  /** Secret NAMES the app declared. */
  secrets: string[];
}

/**
 * What is already attached, read from the cloud rather than from a previous
 * config.
 *
 * The cloud is the state and the config is the intent; a config-to-config diff
 * would need the previous config, which nothing stores and which would be wrong
 * the moment anyone changed something outside a deploy. That assumption is what
 * made `--update-env-vars` a trap.
 */
export interface Live {
  bucketExists: boolean;
  /**
   * Whether the bucket holds objects.
   *
   * Read only to decide whether an UNDECLARED bucket may be detached. An app that
   * has been writing uploads without ever declaring `uses: ["bucket"]` — which is
   * every app deployed before the gate existed, because the platform simply gave
   * everyone one — would lose STORAGE_BUCKET on its next deploy and start failing
   * at runtime on a variable it never asked for and always had.
   *
   * So an in-use bucket stays attached and says so. The alternative is a silent
   * behaviour change that breaks working apps, which is the same class of defect
   * as everything else in this file.
   */
  bucketInUse: boolean;
  databaseExists: boolean;
}

export interface Decision {
  /** Whether the app should have this resource after the deploy. */
  attach: boolean;
  /** Said out loud in the deploy log. Never "because the config says so". */
  reason: string;
}

export interface Kind {
  /** Lower-case, stable, used as an id and in logs. No product nouns. */
  kind: string;
  retention: Retention;
  /** Kinds that must be attached before this one. Ordering is data, not statement order. */
  dependsOn?: string[];
  /** Pure. Given what was declared and what exists, should the app have it? */
  decide(d: Declared, live: Live): Decision;
}

/**
 * The registry.
 *
 * Every entry is a claim about ONE resource, in one place, that can be read
 * without following a 2598-line function. Adding a resource is adding a record
 * here; it is not touching the engine.
 */
export const KINDS: Kind[] = [
  {
    kind: "database",
    // Never destroyed by a config edit. See Retention.
    retention: "detach",
    decide: (d, live) => {
      if (d.externalDatabase) {
        return { attach: false, reason: "the app owns its database — nothing is provisioned" };
      }
      if (d.database) return { attach: true, reason: "declared" };
      if (live.databaseExists) {
        return { attach: false, reason: "no longer declared — credentials withdrawn, the data is kept" };
      }
      return { attach: false, reason: "not declared" };
    },
  },
  {
    kind: "bucket",
    retention: "detach",
    decide: (d, live) => {
      if (d.bucket) return { attach: true, reason: "declared" };
      // The grandfather rule. Every app deployed before this gate existed was
      // given a bucket whether it asked or not, so "undeclared" cannot be read as
      // "unused" for an app that has objects in it.
      if (live.bucketInUse) {
        return { attach: true, reason: "not declared, but it holds objects — add `uses: [\"bucket\"]` to keep it" };
      }
      if (live.bucketExists) {
        return { attach: false, reason: "not declared and empty — credentials withdrawn, the bucket is kept" };
      }
      return { attach: false, reason: "not declared" };
    },
  },
  {
    kind: "db-proxy",
    // A sidecar container. Recreated by the next deploy; holds nothing.
    retention: "remove",
    dependsOn: ["database"],
    decide: (d, live) => {
      const attach = !d.externalDatabase && (d.database || live.databaseExists && false);
      return attach
        ? { attach: true, reason: "the app reaches Postgres through a proxy beside it" }
        : { attach: false, reason: "no platform database to reach" };
    },
  },
  {
    kind: "secrets",
    // The VALUES are the customer's; the mounts are not. Detach so that removing a
    // name from the config stops mounting it without destroying the secret — the
    // same reason `deleteAppSecrets` is only called from the app-delete path.
    retention: "detach",
    decide: (d) => d.secrets.length
      ? { attach: true, reason: `${d.secrets.length} declared` }
      : { attach: false, reason: "none declared" },
  },
  {
    kind: "invoker",
    // An IAM binding. Recreatable, holds nothing.
    retention: "remove",
    decide: (d) => d.web
      ? { attach: true, reason: "the proxy has to be allowed to reach it" }
      : { attach: false, reason: "no web process — nothing to invoke" },
  },
  {
    kind: "domain",
    retention: "remove",
    dependsOn: ["invoker"],
    decide: (d) => d.web
      ? { attach: true, reason: "the app has an address" }
      : { attach: false, reason: "no web process — this app has no URL" },
  },
  {
    kind: "processes",
    retention: "remove",
    dependsOn: ["database", "bucket", "secrets"],
    decide: (d) => d.processes
      ? { attach: true, reason: "declared" }
      : { attach: false, reason: "none declared" },
  },
];

export class ResourceError extends Error {}

export interface Planned {
  kind: string;
  retention: Retention;
  reason: string;
}

export interface ResourcePlan {
  /** Attach or keep, in dependency order. */
  attach: Planned[];
  /** No longer wanted. `remove` kinds are deleted; `detach` kinds are only unwired. */
  release: Planned[];
}

/**
 * Kinds in an order that satisfies their dependencies.
 *
 * Ordering is data here rather than the sequence of statements in a function,
 * which is what it was: a database has to exist before the proxy that reaches it,
 * the proxy before the processes that use it, the invoker binding before the
 * domain mapping that assumes it. Written as statement order, that knowledge is
 * unreadable and a reordering is undetectable.
 */
export function ordered(kinds: Kind[] = KINDS): Kind[] {
  const byName = new Map(kinds.map((k) => [k.kind, k]));
  const out: Kind[] = [];
  const done = new Set<string>();
  const onStack = new Set<string>();

  const visit = (k: Kind) => {
    if (done.has(k.kind)) return;
    if (onStack.has(k.kind)) {
      throw new ResourceError(`resource kinds form a cycle at "${k.kind}" — one of them has to be able to go first`);
    }
    onStack.add(k.kind);
    for (const dep of k.dependsOn ?? []) {
      const d = byName.get(dep);
      // A dependency naming a kind that does not exist is a typo that would
      // otherwise reorder the deploy silently.
      if (!d) throw new ResourceError(`"${k.kind}" depends on "${dep}", which is not a resource kind`);
      visit(d);
    }
    onStack.delete(k.kind);
    done.add(k.kind);
    out.push(k);
  };

  for (const k of kinds) visit(k);
  return out;
}

/**
 * What this deploy should attach and what it should let go of.
 *
 * Pure, and that is the point: every decision about what an app is given can be
 * read, tested and diffed without a cloud. The imperative half is a loop over
 * this — the same split that let `planProcesses` be right the first time it ran
 * against real GCP.
 */
export function planResources(d: Declared, live: Live, kinds: Kind[] = KINDS): ResourcePlan {
  const attach: Planned[] = [];
  const release: Planned[] = [];

  for (const k of ordered(kinds)) {
    const decision = k.decide(d, live);
    (decision.attach ? attach : release).push({
      kind: k.kind,
      retention: k.retention,
      reason: decision.reason,
    });
  }
  // Released in reverse dependency order: the proxy goes before the database it
  // points at, the domain before the binding that allowed it. Tearing down in
  // creation order leaves a window where something references a thing that has
  // just stopped existing.
  release.reverse();
  return { attach, release };
}

/**
 * Whether letting go of this resource may DELETE anything.
 *
 * The single question the imperative half must ask before it runs a destructive
 * command, phrased so that the answer cannot be reached by accident: a caller has
 * to hold a `Planned` and read its retention, rather than remember which kinds
 * are safe.
 */
export function destroys(p: Planned): boolean {
  return p.retention === "remove";
}

/**
 * The env a resource contributes, or nothing when it is not attached.
 *
 * Here rather than inside the database branch, because "which variables does a
 * database mean" was decided by whichever code provisioned it, and the answer it
 * gave was seventeen names guessed at from what frameworks tend to read. One
 * canonical name per resource; anything else the app maps itself.
 */
export function attachedEnv(kind: string, values: Record<string, string>): Record<string, string> {
  switch (kind) {
    case "database": return values.databaseUrl ? { DATABASE_URL: values.databaseUrl } : {};
    case "bucket": return values.bucket ? { STORAGE_BUCKET: values.bucket } : {};
    default: return {};
  }
}
