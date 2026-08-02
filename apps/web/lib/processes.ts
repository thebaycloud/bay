import { DEFAULT_SCALE, withScale, type Scale } from "./lanes";
import { RELEASE_TIMEOUT } from "./release-job";
import type { ProcfileEntry } from "./procfile";

/**
 * What an app RUNS, as opposed to what it is built from.
 *
 * The schema has exactly one expressible shape today: one HTTP server on one
 * port. `validate` refuses any non-static, non-container service without a
 * `start` (lib/resolve.ts), health defaults to `GET / → 200`, and every entry
 * gets a path prefix. So the examples this platform exists for cannot be said:
 *
 *   a Telegram bot   is a worker with no HTTP at all
 *   an agent server  is web + worker
 *   a CRM            is web + cron + release
 *
 * The workaround — deploy the bot as a service and let it fake a listener — does
 * not work either, and that is worth being precise about because it is why this
 * module exists rather than two extra flags. A Cloud Run SERVICE will not serve a
 * revision until the startup probe reaches $PORT, and between requests it
 * throttles CPU to near-zero and scales to zero. `--min-instances=1
 * --no-cpu-throttling` removes the freeze and leaves the port requirement, so the
 * bot still has to pretend to be a web server to exist.
 *
 * The primitive that fits is a WORKER POOL: no HTTP endpoint, no port, no probe,
 * same env, secrets, Cloud SQL and sidecars. Verified against the installed SDK
 * (539.0.0) — `gcloud beta run worker-pools deploy` takes --image/--source,
 * --command/--args, --cpu, --memory, --scaling, --set-env-vars, --set-secrets,
 * --set-cloudsql-instances, --container and --depends-on, and takes NO --port,
 * no probe flags, no --concurrency, no --timeout, no --max-instances and no
 * --cpu-boost.
 *
 * That last sentence is why the sizing types below are per kind rather than one
 * shared `Scale`. Four of `Scale`'s six fields cannot be emitted on a worker
 * pool. Sharing the type would reproduce, on a new axis, exactly the
 * declared-but-ignored defect this whole plan is named after — a field is only as
 * real as the number of primitives that can carry it.
 *
 * NOTHING HERE IS WIRED YET. `deploy-pipeline.ts` does not read this module, so
 * landing it cannot change a deploy that works today. See docs/DEPLOY-PLAN-V2.md
 * step 2 for what connects it.
 */

/** How a process runs. Derived from its name and shape, never authored directly. */
export type ProcessKind = "web" | "worker" | "cron" | "release";

/** The Cloud Run resource a kind becomes. One kind, one primitive, no overlap. */
export type Primitive = "service" | "worker-pool" | "job";

export const PRIMITIVE: Record<ProcessKind, Primitive> = {
  web: "service",
  worker: "worker-pool",
  cron: "job",
  release: "job",
};

/**
 * The two process names that mean something specific, and the rule for the rest.
 *
 * Taken from the Procfile convention rather than invented: `web` is the thing
 * that answers requests, `release` is the thing that runs once before traffic,
 * and every other name is a worker that keeps its own name. That is what Heroku
 * defined, what Render and Railway copied, and what an app's existing Procfile
 * already means — so `bot: python bot.py` produces a worker called `bot` with
 * nobody having to learn our dialect.
 *
 * A schedule is what makes something a cron, because that is the only thing that
 * distinguishes "run this repeatedly" from "run this forever". Deliberately not a
 * name list: `nightly`, `digest` and `cleanup` are all equally plausible and
 * enumerating them would be the same mistake as enumerating languages.
 */
export const WEB = "web";
export const RELEASE = "release";

/** What the author may declare on any process. */
export interface ProcessConfig {
  command?: string;
  /** Overrides the inferred kind. Rarely needed; `schedule` and the name usually settle it. */
  kind?: ProcessKind;
  memory?: string;
  cpu?: number;

  /** web only. */
  visibility?: "public" | "internal";
  health?: { path: string; expect: number };
  maxInstances?: number;
  concurrency?: number;
  cpuBoost?: boolean;
  timeout?: number;

  /** worker only. A fixed count — see WorkerProcess.instances. */
  instances?: number;

  /** cron only. */
  schedule?: string;
  /**
   * cron only. IANA name — "Europe/Berlin". Defaults to UTC.
   *
   * Not decoration: "0 3 * * *" means 3am somewhere, and a nightly report that
   * fires at 3am UTC for a business in Almaty runs at 8am, in the middle of the
   * working day. Cloud Scheduler takes this directly (`--time-zone`), so the only
   * way to get it wrong is not to offer it.
   */
  timezone?: string;

  /** cron + release. */
  taskTimeout?: number;
  retries?: number;

  /** web + worker. Parses today, emits at step 4 — see `unemittable`. */
  shutdownGrace?: number;
}

export interface ProcessBase {
  name: string;
  command: string;
  /** The fields the AUTHOR wrote. Same reason ResolvedService carries one. */
  declared: string[];
}

export interface WebProcess extends ProcessBase {
  kind: "web";
  /**
   * Whether the world may reach it. `internal` is Cloud Run's `--ingress=internal`.
   *
   * An orthogonal field rather than a fifth kind, which is where this differs
   * from Render's separate `pserv` type. An agent server's private API is a `web`
   * that is not public, and modelling it as its own kind would mean every field
   * `web` has getting a second copy for no gain — while `web` + `worker` +
   * `visibility` composes into the same shape.
   */
  visibility: "public" | "internal";
  health: { path: string; expect: number };
  /** Unchanged from today's Scale, deliberately, so `web` is bit-for-bit as it was. */
  scale: Scale;
  shutdownGrace?: number;
}

export interface WorkerProcess extends ProcessBase {
  kind: "worker";
  /**
   * A FIXED instance count, not a {min,max} range.
   *
   * `--scaling` on SDK 539.0.0 takes a positive integer and nothing else; there
   * is no metric-driven autoscaling reachable from the CLI. A `{min,max}` field
   * here would be a field the primitive cannot emit, which is the defect this
   * module is built to avoid — so the schema says what can actually be done and
   * grows when the primitive does.
   */
  instances: number;
  memory: string;
  cpu: number;
  shutdownGrace?: number;
}

export interface TaskProcess extends ProcessBase {
  kind: "cron" | "release";
  /** cron only; absent on release, which runs when a deploy says so. */
  schedule?: string;
  /** cron only. IANA name, defaulting to UTC. */
  timezone?: string;
  memory: string;
  cpu: number;
  taskTimeout: number;
  retries: number;
}

export type ResolvedProcess = WebProcess | WorkerProcess | TaskProcess;

export class ProcessError extends Error {}

/**
 * Fields a process may declare, by kind.
 *
 * Unlike LANE_CONSUMES this is not a claim about what some code path happens to
 * read — it is a statement about what the PRIMITIVE accepts, checked against
 * `gcloud`'s own flag list. That is the difference the old capability table
 * lacked: it was a second declaration by the same author as the first, so it
 * agreed with the config and both were wrong together.
 */
const ALLOWED: Record<ProcessKind, ReadonlyArray<keyof ProcessConfig>> = {
  web: ["command", "kind", "memory", "cpu", "visibility", "health", "maxInstances", "concurrency", "cpuBoost", "timeout", "shutdownGrace"],
  worker: ["command", "kind", "memory", "cpu", "instances", "shutdownGrace"],
  cron: ["command", "kind", "memory", "cpu", "schedule", "timezone", "taskTimeout", "retries"],
  release: ["command", "kind", "memory", "cpu", "taskTimeout", "retries"],
};

/**
 * Fields that parse and validate but cannot be emitted yet, with the reason.
 *
 * `terminationGracePeriodSeconds` is a spec field with no `gcloud run` flag, so
 * it is reachable only once deploys emit YAML and `replace` (step 4). Recorded
 * rather than dropped, because dropping it silently is precisely the class of
 * defect the previous plan spent itself closing — a declared field that takes no
 * effect and says nothing.
 */
export function unemittable(p: ResolvedProcess): string[] {
  const out: string[] = [];
  if ((p.kind === "web" || p.kind === "worker") && p.shutdownGrace !== undefined) {
    out.push(
      `${p.name}.shutdownGrace is not emitted yet — terminationGracePeriodSeconds has no gcloud flag ` +
      `and needs the spec-replace path (DEPLOY-PLAN-V2 step 4)`,
    );
  }
  return out;
}

/** Cloud Run's own default for a job task that says nothing. */
export const DEFAULT_TASK_TIMEOUT = RELEASE_TIMEOUT;

/**
 * Retries default to none, for both task kinds.
 *
 * Carried over from releaseJobArgs, where the reasoning is written out: a
 * migration that failed half way is not improved by being run again thirty
 * seconds later against the schema it just half-changed, and the retries bury the
 * first failure — the one that says what went wrong — under two more. A nightly
 * job is the same shape of thing. Declarable, so an idempotent fetch can ask for
 * retries; not the default, so a destructive one does not get them by accident.
 */
export const DEFAULT_RETRIES = 0;

/** A worker's instance count when nobody says. One is a worker; zero is not running. */
export const DEFAULT_INSTANCES = 1;

/**
 * The kind a process is, from its name and what it declares.
 *
 * Explicit `kind` wins, then a schedule, then the two reserved names, then
 * worker. No name list beyond `web` and `release`: those two are the Procfile
 * convention and everything else is the app's own vocabulary.
 */
export function deriveKind(name: string, c: ProcessConfig): ProcessKind {
  if (c.kind) return c.kind;
  if (c.schedule) return "cron";
  if (name === WEB) return "web";
  if (name === RELEASE) return "release";
  return "worker";
}

/** Which fields the author actually wrote, so a default is never mistaken for a declaration. */
function declaredFields(c: ProcessConfig): string[] {
  const set = (v: unknown) => v !== undefined && v !== null && !(typeof v === "string" && !v.trim());
  return (Object.keys(c) as Array<keyof ProcessConfig>).filter((k) => set(c[k]));
}

/**
 * Refuse a process that declared something its primitive cannot carry.
 *
 * Before anything is built, and naming the field — a worker asking for
 * `concurrency` is asking a worker pool for a flag it does not have, and finding
 * that out from `gcloud: unrecognized arguments` after a nine-minute build is
 * finding it out at the least useful moment.
 */
export function assertEmittable(name: string, kind: ProcessKind, c: ProcessConfig): void {
  const allowed = new Set<string>(ALLOWED[kind]);
  const stray = declaredFields(c).filter((f) => !allowed.has(f));
  if (!stray.length) return;
  throw new ProcessError(
    `process "${name}" is a ${kind} and cannot declare: ${stray.join(", ")}\n` +
    `  A ${kind} runs as a Cloud Run ${PRIMITIVE[kind]}, which has no such setting — ` +
    `the deploy would accept ${stray.length === 1 ? "it" : "them"} and ignore ${stray.length === 1 ? "it" : "them"}.`,
  );
}

function positive(v: number | undefined, field: string, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || v < 1) {
    throw new ProcessError(`process "${name}": ${field} must be a whole number of 1 or more (got ${JSON.stringify(v)})`);
  }
  return v;
}

/** One process, fully resolved: kind decided, every optional field given its default. */
export function resolveProcess(name: string, c: ProcessConfig): ResolvedProcess {
  const command = (c.command ?? "").trim();
  if (!command) throw new ProcessError(`process "${name}" has no command`);

  const kind = deriveKind(name, c);
  assertEmittable(name, kind, c);

  const declared = declaredFields(c);
  const base = { name, command, declared };
  // One memory floor for every kind, on purpose. 2Gi comes from a measurement —
  // Cloud Run's 512Mi default OOM-kills a real Node app at 564Mi before it binds
  // $PORT — and inventing a SECOND, smaller, unmeasured number for workers would
  // be the same kind of constant this plan is removing. Overridable per process.
  const memory = c.memory ?? DEFAULT_SCALE.memory;
  const cpu = c.cpu ?? DEFAULT_SCALE.cpu;

  if (kind === "web") {
    return {
      ...base,
      kind,
      visibility: c.visibility ?? "public",
      health: c.health ?? { path: "/", expect: 200 },
      // Through withScale so the undefined-dropping rule holds here too: spreading
      // a partial over DEFAULT_SCALE overwrites defaults with undefined, which is
      // how `--concurrency undefined` once reached gcloud.
      scale: withScale({
        memory: c.memory, cpu: c.cpu,
        maxInstances: c.maxInstances, timeout: c.timeout,
        concurrency: c.concurrency, cpuBoost: c.cpuBoost,
      }),
      shutdownGrace: positive(c.shutdownGrace, "shutdownGrace", name),
    };
  }

  if (kind === "worker") {
    return {
      ...base,
      kind,
      instances: positive(c.instances, "instances", name) ?? DEFAULT_INSTANCES,
      memory,
      cpu,
      shutdownGrace: positive(c.shutdownGrace, "shutdownGrace", name),
    };
  }

  if (kind === "cron" && !c.schedule?.trim()) {
    throw new ProcessError(`process "${name}" is a cron and needs a "schedule" — a cron expression like "0 3 * * *"`);
  }

  return {
    ...base,
    kind,
    schedule: c.schedule?.trim(),
    timezone: c.timezone?.trim(),
    memory,
    cpu,
    taskTimeout: positive(c.taskTimeout, "taskTimeout", name) ?? DEFAULT_TASK_TIMEOUT,
    retries: c.retries ?? DEFAULT_RETRIES,
  };
}

/**
 * Fold a Procfile into declared processes.
 *
 * The Procfile supplies commands for names nobody declared, and `processes`
 * supplies everything else — so an app can keep the Procfile it already had and
 * still say `instances: 3` for its worker, without repeating the command in two
 * files.
 *
 * A name declared in BOTH with two different commands is refused rather than
 * resolved. Silently preferring either leaves the other looking ignored, which is
 * the same rule that already refuses `preDeploy` beside a different `release` —
 * and the cost of guessing here is a worker running a command its author thinks
 * they replaced.
 */
export function mergeProcfile(
  declared: Record<string, ProcessConfig> | undefined,
  procfile: ProcfileEntry[] | null,
): Record<string, ProcessConfig> {
  const out: Record<string, ProcessConfig> = {};

  for (const entry of procfile ?? []) out[entry.name] = { command: entry.command };

  for (const [name, cfg] of Object.entries(declared ?? {})) {
    const fromFile = out[name];
    if (fromFile && cfg.command && cfg.command.trim() !== fromFile.command) {
      throw new ProcessError(
        `process "${name}" has one command in Procfile and a different one in supersonic.json:\n` +
        `  Procfile:        ${fromFile.command}\n` +
        `  supersonic.json: ${cfg.command}\n` +
        `  Keep one. Leave "command" out of supersonic.json to use the Procfile's.`,
      );
    }
    out[name] = { ...fromFile, ...cfg };
  }

  return out;
}

/**
 * Every process of a service, resolved, with `web` first.
 *
 * Order is part of the shape for the same reason the primary service comes first
 * in ResolvedApp: `web` is the thing the app's own address lands on, and the rest
 * are deployed beside it.
 */
export function resolveProcesses(configs: Record<string, ProcessConfig>): ResolvedProcess[] {
  const resolved = Object.entries(configs).map(([name, c]) => resolveProcess(name, c));

  const webs = resolved.filter((p) => p.kind === "web");
  if (webs.length > 1) {
    throw new ProcessError(
      `a service has ${webs.length} web processes (${webs.map((p) => p.name).join(", ")}) — ` +
      `only one can answer on the service's address. Split them into two services, each with its own path.`,
    );
  }

  const releases = resolved.filter((p) => p.kind === "release");
  if (releases.length > 1) {
    throw new ProcessError(
      `a service has ${releases.length} release processes (${releases.map((p) => p.name).join(", ")}) — ` +
      `the release phase runs exactly once, before traffic.`,
    );
  }

  return [...webs, ...resolved.filter((p) => p.kind !== "web")];
}
