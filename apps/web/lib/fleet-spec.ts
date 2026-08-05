import type { ResolvedProcess } from "./processes";
import type { SecretRef } from "./app-secrets";

/**
 * The placement spec: everything a node needs to run one app, and nothing else.
 *
 * This is the agent's `App` struct (services/fleet/agent/main.go), and
 * test/fleet-spec.test.ts reads that struct and fails when the two drift. The
 * comment this replaces claimed the same thing and was wrong — the agent grew
 * `secrets` and `processes`, the control plane's copy did not, and the result
 * was a spec that could not express a worker or a database. That is most of why
 * 9 of 47 apps could not be moved, and a comment was never going to catch it.
 *
 * Stored denormalised on the placement row, deliberately. Resolving it per pull
 * would put the deploy pipeline's whole vocabulary — lanes, frameworks, process
 * kinds — on the serving path, and the agent would have to learn all of it.
 * Translation happens once, here, at deploy time.
 */
export interface AppSpec {
  slug: string;
  image: string;
  command?: string[];
  env?: Record<string, string>;
  /**
   * Env var name → Secret Manager secret id. A REFERENCE, never a value.
   *
   * The node resolves these at start with its own service account. A value here
   * would put every app's database password in a Postgres table the platform
   * reads on every reconcile, and on node disk in a world-readable config.
   */
  secrets?: Record<string, string>;
  port: number;
  memoryBytes: number;
  cpuShares: number;
  healthPath?: string;
  processes?: AgentProcess[];
}

/** One process, in the agent's vocabulary. Mirrors `Process` in process.go. */
export interface AgentProcess {
  name: string;
  kind: "web" | "worker" | "cron" | "release";
  command?: string[];
  /**
   * The image THIS process runs, when it is not the app's own program.
   *
   * Absent means the app's image, which is right for web, worker and release —
   * the same code entered differently. It is wrong for anything an app needs
   * beside itself: a sibling service builds its own image, and a dependency is
   * somebody else's entirely.
   */
  image?: string;
  port?: number;
  /**
   * The path this process serves, when an app has more than one program behind
   * one address. Absent serves everything.
   */
  prefix?: string;
  healthPath?: string;
  visibility?: "public" | "internal";
  schedule?: string;
  timezone?: string;
  memoryBytes?: number;
  cpuShares?: number;
  shutdownGrace?: number;
}

export interface SpecInput {
  slug: string;
  image: string;
  /** The pipeline's own shape: `K=V` strings. */
  env: string[];
  secrets: SecretRef[];
  processes: ResolvedProcess[];
  /**
   * A release declared in config rather than in a Procfile.
   *
   * On Cloud Run these were two different mechanisms — a Procfile line became a
   * process, and this became a job — so nothing ever needed them to agree. A
   * node has one primitive, and an app whose migrations never run is an app that
   * serves its homepage and fails everything else.
   */
  releaseCommand?: string | null;
  /**
   * Whether this app genuinely has no web process — a bot, a queue consumer, a
   * cron-only app.
   *
   * Read by the pipeline from the process list BEFORE it appends anything to it,
   * which is the only moment an empty list still means "one implicit web
   * process". By the time this function sees the list that fact is unrecoverable
   * from the list itself, so it has to travel separately. Optional, and absent
   * means "do not decide": a caller that does not know must not have this
   * function guess a web process into existence.
   */
  serviceless?: boolean;
  port?: number;
  memoryBytes?: number;
  cpuShares?: number;
  healthPath?: string;
}

/** What migrate.sh hardcoded, now named. */
const DEFAULT_PORT = 8080;
const DEFAULT_MEMORY = 2 * 1024 * 1024 * 1024;
const DEFAULT_CPU_SHARES = 1024;

/**
 * `512Mi` → bytes.
 *
 * Cloud Run's spelling, which is what the process schema accepts, into the
 * cgroup's. Anything unparseable returns undefined rather than a guess: the
 * agent falls back to the app-wide limit for a zero, and a wrong number here is
 * an OOM kill at 3am that reads as the app's fault.
 */
export function memoryBytes(memory: string | undefined): number | undefined {
  if (!memory) return undefined;
  const m = /^(\d+(?:\.\d+)?)(Mi|Gi|M|G)?$/.exec(memory.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  switch (m[2]) {
    case "Gi": case "G": return Math.round(n * 1024 * 1024 * 1024);
    case "Mi": case "M": case undefined: return Math.round(n * 1024 * 1024);
    default: return undefined;
  }
}

/**
 * A CPU count → the cgroup's share weight.
 *
 * One CPU is 1024 shares — what migrate.sh hardcoded and what DEFAULT_CPU_SHARES
 * still means. Fractional counts are valid in the schema and on Cloud Run, so
 * 0.5 is 512 rather than a rejection.
 *
 * Zero, negative and non-finite return undefined for the same reason
 * `memoryBytes` does: the agent reads a zero as "use the app-wide limit", and a
 * wrong number here is a throttled app at 3am that reads as the app's fault.
 */
export function cpuShares(cpu: number | undefined): number | undefined {
  if (cpu === undefined || !Number.isFinite(cpu) || cpu <= 0) return undefined;
  return Math.round(cpu * DEFAULT_CPU_SHARES);
}

/**
 * A start command, as the thing that will actually read it.
 *
 * The agent execs argv directly. The Cloud Run path wraps every command in
 * `/bin/sh -c` (see `shellCommand`), because an app's start command is a shell
 * line — pipes, `&&`, quoting — and not an argv. Both runtimes have to read one
 * Procfile line the same way or the runtime becomes part of the app's meaning.
 */
function shellArgv(command: string): string[] {
  return ["/bin/sh", "-c", command];
}

function agentProcess(p: ResolvedProcess): AgentProcess {
  const out: AgentProcess = { name: p.name, kind: p.kind };
  if (p.command) out.command = shellArgv(p.command);

  if (p.kind === "web") {
    // No per-process port. It used to be DEFAULT_PORT unconditionally, and the
    // agent's `effectivePort` prefers the PROCESS value over the app's — so the
    // app-level port, which is the one the deploy actually resolved, could never
    // win. Leaving it unset makes `spec.port` authoritative, which is where a
    // single answer for the app belongs; the agent falls back to 8080 itself if
    // both are absent.
    out.healthPath = p.health.path;
    // Sent only when it is the answer the author gave. `public` is the agent's
    // default, and stating it changes nothing; `internal` means "do not publish
    // a route", which is the whole of what an app's private API needs here.
    if (p.visibility === "internal") out.visibility = "internal";
    if (p.shutdownGrace) out.shutdownGrace = p.shutdownGrace;
  }
  if (p.kind === "worker") {
    // No port, deliberately: a port is what puts a process in the routing table,
    // and a bot answering HTTP it never serves is a 502 with the app's name on it.
    const mem = memoryBytes(p.memory);
    if (mem) out.memoryBytes = mem;
    const shares = cpuShares(p.cpu);
    if (shares) out.cpuShares = shares;
    if (p.shutdownGrace) out.shutdownGrace = p.shutdownGrace;
  }
  if (p.kind === "cron" || p.kind === "release") {
    const mem = memoryBytes(p.memory);
    if (mem) out.memoryBytes = mem;
    const shares = cpuShares(p.cpu);
    if (shares) out.cpuShares = shares;
    if (p.schedule) out.schedule = p.schedule;
    if (p.timezone) out.timezone = p.timezone;
  }
  return out;
}

/**
 * The pipeline's vocabulary, translated once, into the node's.
 *
 * Pure and separate from lib/fleet.ts on purpose: everything here is checkable
 * against what the agent actually parses without a database, which is the only
 * reason the drift above was findable at all.
 */
export function buildAppSpec(i: SpecInput): AppSpec {
  const env: Record<string, string> = {};
  for (const pair of i.env) {
    // First `=` only. A DATABASE_URL carries `?sslmode=require`, and splitting
    // on every `=` truncates it into a connection string that fails at runtime
    // rather than here.
    const at = pair.indexOf("=");
    if (at > 0) env[pair.slice(0, at)] = pair.slice(at + 1);
  }

  const secrets: Record<string, string> = {};
  for (const r of i.secrets) secrets[r.key] = r.name;

  const spec: AppSpec = {
    slug: i.slug,
    image: i.image,
    port: i.port ?? DEFAULT_PORT,
    memoryBytes: i.memoryBytes ?? DEFAULT_MEMORY,
    cpuShares: i.cpuShares ?? DEFAULT_CPU_SHARES,
    healthPath: i.healthPath ?? "/",
  };
  if (Object.keys(env).length) spec.env = env;
  if (Object.keys(secrets).length) spec.secrets = secrets;
  const declared = i.processes.map(agentProcess);
  // A release declared in config only ever existed as a Cloud Run Job — nothing
  // in a Procfile named it, so `declared` would not otherwise contain it. Added
  // only when no Procfile line already claimed the name "release", the same
  // precedence the pipeline gives a Procfile-declared process over the inferred
  // one.
  if (i.releaseCommand && !declared.some((p) => p.name === "release")) {
    declared.push({ name: "release", kind: "release", command: shellArgv(i.releaseCommand) });
  }

  // The implicit web process, restored when something else has already made the
  // list non-empty.
  //
  // An empty list means ONE IMPLICIT WEB PROCESS — the comment below says so and
  // `processesOf` implements it. But an app whose web came from `start` rather
  // than from a Procfile has an empty list, and the pipeline appends its release
  // to that list before this function is ever called. The list is then
  // `[release]`: non-empty, so the implicit rule no longer applies, and the
  // agent runs exactly what is in it. The app migrates its database and serves
  // nothing.
  //
  // Measured on 5 Aug on p6mx8/goapi, the first app ever placed on the fleet
  // with a release. The spec that reached fleet_placements was `[release]`
  // alone and placeOnFleet refused to flip: "this placement declares no
  // long-running process". Before that check existed the same spec would have
  // been placed and rolled back for not answering — same outcome, and a reason
  // that points at the app instead of at the spec.
  //
  // Gated on `serviceless` because that is the ONLY thing that distinguishes
  // this from an app which correctly has no web: a bot declares `[bot]`, a
  // cron-only app declares `[nightly]`, and neither is owed one. The pipeline
  // decides `serviceless` from the process list BEFORE it appends anything, so
  // it is the one reading taken while the emptiness still meant something.
  //
  // No command on the synthesised entry, deliberately: that is what
  // `processesOf` builds for the implicit case, and it lets the image's own
  // entrypoint run — the app's `start`, already baked in by the Dockerfile.
  // Naming a command here would be this function inventing one.
  if (i.serviceless === false && declared.length && !declared.some((p) => p.kind === "web" || p.kind === "worker")) {
    declared.unshift({ name: "web", kind: "web" });
  }
  // Absent rather than empty, and the difference is load-bearing: `processesOf`
  // reads a zero-length list as "one implicit web process built from the app's
  // own port and health path". An empty array takes the other branch and places
  // an app that runs nothing.
  if (declared.length) spec.processes = declared;

  return spec;
}
