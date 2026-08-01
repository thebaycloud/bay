import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeployPlan } from "./opencode-deploy";

/**
 * `supersonic.json` — the deploy plan, written down.
 *
 * The planner is good and it is also the slowest, least predictable part of a
 * deploy: it costs 40–180s, it thrashes on some repos, and the same repository
 * can plan differently on two consecutive days. None of that is necessary when
 * somebody already knows the answer — and for an app built by a coding agent,
 * somebody does. The agent that wrote the repo knows how to install and run it
 * far better than a planner rediscovering it from `ls`.
 *
 * So this file is the fast path, not a prerequisite: present, it is obeyed and no
 * model runs at all; absent, nothing changes and the planner works as before. The
 * zero-config promise is unaffected — what changes is that a project can stop
 * paying for inference it does not need, and can pin behaviour it cares about.
 *
 * It is deliberately `services: [...]` even though exactly one entry is supported
 * today. Multi-service is a SCHEMA problem, not an inference problem — no amount
 * of planner cleverness can express a Next.js frontend beside a Python API,
 * because there is nowhere to put the second one. Shipping the array now means
 * adding the second service later is not a breaking change to every file already
 * written.
 */

export const CONFIG_FILENAME = "supersonic.json";

export interface ServiceConfig {
  name?: string;
  /** Where this service's commands run, relative to the repo root. Default ".". */
  dir?: string;
  language?: "node" | "python" | "static" | "other";
  install?: string;
  build?: string;
  /**
   * One-shot steps that must run ONCE per deploy — migrations, above all.
   *
   * Separate from `start` because they are not the same kind of thing, and
   * conflating them has a real cost: folded into the start command, a migration
   * re-runs on every cold start and every scale-out instance, concurrently.
   * Prisma takes an advisory lock and survives that; Alembic does not.
   */
  preDeploy?: string;
  /** The long-running command. Serves HTTP on $PORT. */
  start?: string;
  /** Static only: the built directory, relative to `dir`. */
  outputDir?: string;
  needsDB?: boolean;
  /** Env var NAMES the service reads. Never values. */
  env?: string[];
  /**
   * The path prefix this service serves, on the app's single hostname. Default "/".
   *
   * Path routing rather than a hostname each: same origin means no CORS and
   * nothing to bake into a frontend bundle at build time. See services/proxy/src/routes.ts.
   */
  path?: string;
}

export interface AppConfig {
  version?: number;
  services: ServiceConfig[];
}

export class ConfigError extends Error {}

const LANGUAGES = new Set(["node", "python", "static", "other"]);

/** A path that stays inside the repo. */
function safeDir(dir: unknown, where: string): string {
  if (dir === undefined || dir === null || dir === "") return ".";
  if (typeof dir !== "string") throw new ConfigError(`${where}: "dir" must be a string`);
  const d = dir.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (!d || d === ".") return ".";
  // These commands are interpolated into a shell and a tar path. A `dir` that
  // climbs out of the repo, or is absolute, is not a configuration mistake this
  // should try to interpret.
  if (d.startsWith("/") || d.split("/").includes("..")) {
    throw new ConfigError(`${where}: "dir" must be inside the repository (got ${JSON.stringify(dir)})`);
  }
  return d;
}

function str(v: unknown, where: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ConfigError(`${where} must be a string`);
  return v;
}

/**
 * Parse and validate. Throws ConfigError with a message meant for the person who
 * wrote the file — a config that is present and wrong must fail loudly, because
 * silently falling back to the planner would make a typo look like the platform
 * ignoring them.
 */
export function parseAppConfig(text: string): AppConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${CONFIG_FILENAME} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(`${CONFIG_FILENAME} must be a JSON object`);
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.services) || o.services.length === 0) {
    throw new ConfigError(`${CONFIG_FILENAME} needs a non-empty "services" array`);
  }
  const services = o.services.map((s, i): ServiceConfig => {
    const where = `${CONFIG_FILENAME} services[${i}]`;
    if (!s || typeof s !== "object" || Array.isArray(s)) throw new ConfigError(`${where} must be an object`);
    const svc = s as Record<string, unknown>;
    const language = str(svc.language, `${where}.language`);
    if (language !== undefined && !LANGUAGES.has(language)) {
      throw new ConfigError(`${where}.language must be one of ${[...LANGUAGES].join(", ")}`);
    }
    if (svc.env !== undefined && (!Array.isArray(svc.env) || svc.env.some((e) => typeof e !== "string"))) {
      throw new ConfigError(`${where}.env must be an array of variable NAMES`);
    }
    return {
      name: str(svc.name, `${where}.name`),
      dir: safeDir(svc.dir, where),
      language: language as ServiceConfig["language"],
      install: str(svc.install, `${where}.install`),
      build: str(svc.build, `${where}.build`),
      preDeploy: str(svc.preDeploy, `${where}.preDeploy`),
      start: str(svc.start, `${where}.start`),
      outputDir: str(svc.outputDir, `${where}.outputDir`),
      needsDB: svc.needsDB === undefined ? undefined : Boolean(svc.needsDB),
      env: svc.env as string[] | undefined,
      path: str(svc.path, `${where}.path`),
    };
  });
  // Checked here rather than at deploy time: two services claiming the same
  // prefix means one of them silently never receives a request, which is
  // indistinguishable from that service being broken.
  const seen = new Set<string>();
  for (const s of services) {
    const p = servicePath(s);
    if (seen.has(p)) throw new ConfigError(`${CONFIG_FILENAME}: two services both serve ${p}`);
    seen.add(p);
  }
  return { version: typeof o.version === "number" ? o.version : 1, services };
}


/**
 * Which service owns "/" — the one the app's URL lands on, and the one deployed
 * as the app itself rather than as a sibling.
 *
 * The service explicitly claiming "/" wins; otherwise the first declared. A repo
 * that lists its API first and its frontend second still gets the frontend on
 * the bare URL if it says `"path": "/"`, which is what anyone would expect.
 */
export function primaryService(config: AppConfig): ServiceConfig {
  return config.services.find((s) => (s.path ?? "/") === "/") ?? config.services[0];
}

/** Every service except the primary, in declaration order. */
export function extraServices(config: AppConfig): ServiceConfig[] {
  const primary = primaryService(config);
  return config.services.filter((s) => s !== primary);
}

/**
 * A service's path prefix, normalised.
 *
 * Two services cannot share one, and nothing may be routed to a prefix that
 * cannot be matched: `pickRoute` in the proxy only ever matches at a path
 * boundary, so a prefix without a leading slash would silently receive no
 * traffic at all rather than failing.
 */
export function servicePath(s: ServiceConfig): string {
  const p = (s.path ?? "/").trim();
  if (!p.startsWith("/")) throw new ConfigError(`${CONFIG_FILENAME}: "path" must start with / (got ${JSON.stringify(s.path)})`);
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * Run a command inside a subdirectory, in a SUBSHELL.
 *
 * The parentheses are the whole point. Each command is prefixed independently,
 * and the lanes disagree about how they run them: the runner executes install
 * and build as separate `sh -c` calls, while the static lane joins them into one
 * shell with `&&`. A bare `cd frontend && npm ci && cd frontend && npm run build`
 * therefore installs correctly and then fails with
 * `cd: frontend: No such file or directory`, because the first `cd` is still in
 * effect and there is no frontend/frontend. A subshell cannot leak its directory
 * to whatever runs next, so the same string is correct under both lanes.
 */
export function inDir(cmd: string | undefined, dir: string): string | undefined {
  if (cmd === undefined) return undefined;
  if (!cmd.trim()) return "";
  return dir === "." ? cmd : `(cd ${dir} && ${cmd})`;
}

/**
 * The config's single service, expressed as the plan the pipeline already speaks.
 *
 * Reusing DeployPlan is deliberate: everything downstream — the runner lane, the
 * dependency check, the static lane — already handles that shape, so a config
 * takes exactly the same path as a planned deploy and cannot drift into a second,
 * differently-behaved code path.
 */
export function planFromConfig(config: AppConfig, service?: ServiceConfig, source: string = CONFIG_FILENAME): DeployPlan {
  const s = service ?? primaryService(config);
  const dir = s.dir ?? ".";
  const isStatic = s.language === "static";
  return {
    language: s.language ?? "node",
    install: inDir(s.install, dir),
    build: inDir(s.build, dir),
    // preDeploy stays a separate field on the plan; the pipeline decides where it
    // runs. Migrations belong in the prepare step, once, rather than in the start
    // command — but that needs the app's env at build time, so today they are
    // still folded ahead of `start` exactly as a planned deploy does.
    preRun: s.preDeploy ? [inDir(s.preDeploy, dir) as string] : undefined,
    run: inDir(s.start, dir) ?? "",
    static: isStatic,
    outputDir: isStatic ? (dir === "." ? (s.outputDir ?? ".") : `${dir}/${s.outputDir ?? "."}`.replace(/\/\.$/, "")) : undefined,
    needsDB: s.needsDB,
    envNeeded: s.env,
    // `source` because this same shape is now produced two ways: read out of the
    // user's file, and inferred from the repository by infer-services. Printing
    // `Plan ready: supersonic.json` for the second sends someone looking for a
    // file that is not there — the same class of defect as a confidence number
    // nothing reads.
    reason: `${source}${s.name ? ` (${s.name})` : ""}`,
  };
}

/** The repo's config, or null when it has none. Throws ConfigError if it is unusable. */
export function readAppConfig(dir: string): AppConfig | null {
  const path = join(dir, CONFIG_FILENAME);
  if (!existsSync(path)) return null;
  return parseAppConfig(readFileSync(path, "utf8"));
}
