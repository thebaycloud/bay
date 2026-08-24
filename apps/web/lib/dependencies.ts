/**
 * What an app needs BESIDE itself, and where each kind of thing runs.
 *
 * The platform already provisions two: a Postgres database and a bucket. Both
 * are managed — one shared Cloud SQL instance with a database and role per app,
 * one GCS bucket — and both took real code to get right, most of it in the
 * DELETE path rather than the create.
 *
 * A node changes what is cheap. A process with its own image is now a primitive,
 * so a cache beside an app is one more entry in its placement rather than a new
 * subsystem. That does not make every dependency a sidecar, and the difference
 * is what this file decides.
 *
 * ## The rule
 *
 * A dependency runs as a SIDECAR when losing it costs the app nothing that
 * cannot be rebuilt, and it fits beside twenty-five other apps on one machine.
 * It is MANAGED when its data is the point, or when one instance would eat the
 * node.
 *
 * By that rule:
 *
 * - `redis` is a sidecar. It is a cache; an empty cache is a slow request, not a
 *   lost customer. It idles at a few megabytes, and giving each app its own
 *   removes the noisy-neighbour problem a shared one would create.
 * - `database` stays managed. It is the app's data, it has to survive the node,
 *   and it already works.
 * - `bucket` stays managed, for the same reason and because object storage on a
 *   node is not object storage.
 * - `elasticsearch` is refused. A JVM with a default heap is gigabytes; forty of
 *   them do not fit on a 64 GiB machine, and one shared instance across tenants
 *   is a data-isolation problem this platform has deliberately not taken on
 *   anywhere else. Refused with the number, so the answer is arguable rather
 *   than mysterious.
 *
 * ## What a sidecar must not have
 *
 * No route. It is reachable by the app that declares it and by nothing else,
 * which on a node is what `visibility: internal` already means.
 *
 * No persistence, today. `/srv/apps` survives a reboot only where a data disk
 * has been attached, and a cache that is sometimes durable teaches people to
 * rely on it. Redis is started with persistence off, deliberately and visibly.
 */

/** Everything an app may declare, including the ones that are refused. */
type DependencyKind = "database" | "bucket" | "redis" | "elasticsearch";

export interface SidecarSpec {
  /** Process name, and the handle the app's env refers to it by. */
  name: string;
  image: string;
  command?: string[];
  /** The port it listens on inside its own sandbox. */
  port: number;
  memoryBytes: number;
  /** `KEY=value`, where a value may contain the address placeholder below. */
  env: string[];
}

/**
 * How a process refers to a sibling's address before either has one.
 *
 * A placement is written before anything is placed, so no IP exists yet — the
 * node assigns one per process at start. The spec therefore carries a name and
 * the agent substitutes the address, which also means a restart that moves a
 * process to another slot does not leave a stale address behind in an env var.
 */
export const addressPlaceholder = (process: string) => `\${process:${process}}`;

/** The refusals, with the reason stated rather than implied. */
export function dependencyRefusal(kind: string): string | null {
  if (kind === "elasticsearch") {
    return "elasticsearch needs gigabytes of JVM heap per instance, which does not fit beside the other apps on a node, "
      + "and one shared cluster across tenants is an isolation problem this platform does not take on anywhere else";
  }
  return null;
}

/**
 * The sidecar for a declared dependency, or null when it is not one.
 *
 * `database` and `bucket` return null and stay managed — they are provisioned
 * before this is consulted and have nothing to do with a node.
 */
export function sidecarFor(kind: string): SidecarSpec | null {
  if (kind !== "redis") return null;
  return {
    name: "redis",
    image: "docker.io/library/redis:7-alpine",
    // Persistence off, said out loud in the argv rather than left to the image's
    // default. A cache that is sometimes durable is worse than one that never
    // is: the first time it survives a restart, somebody starts relying on it.
    command: ["redis-server", "--save", "", "--appendonly", "no"],
    port: 6379,
    // 256 MiB. Big enough to be a useful cache, small enough that twenty-five of
    // them are a rounding error on the node, and a ceiling rather than a
    // reservation — an app that wants more is asking for a managed one.
    memoryBytes: 256 * 1024 * 1024,
    env: [],
  };
}

/**
 * The variables an app reads to find its cache.
 *
 * Every spelling in common use, for the same reason `databaseEnv` writes
 * seventeen: plenty of apps never read `REDIS_URL` and want `REDIS_HOST`.
 */
export function sidecarEnv(spec: SidecarSpec): string[] {
  if (spec.name !== "redis") return spec.env;
  const at = addressPlaceholder(spec.name);
  return [
    `REDIS_URL=redis://${at}:${spec.port}`,
    `REDIS_HOST=${at}`,
    `REDIS_PORT=${spec.port}`,
    `CACHE_URL=redis://${at}:${spec.port}`,
  ];
}
