import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeployPlan } from "./opencode-deploy";
import { databaseEnvNames } from "./lanes";

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

/** What "the app responds" means. Success stops meaning "the process did not exit". */
export interface HealthConfig {
  path: string;
  expect: number;
}

/**
 * What the service may consume. Every field is optional and falls back to
 * DEFAULT_SCALE in lib/lanes.ts; declaring one overrides only that one.
 */
export interface ScaleConfig {
  memory?: string;
  cpu?: number;
  maxInstances?: number;
  timeout?: number;
  concurrency?: number;
  cpuBoost?: boolean;
}

/** Provisioned once per APP, not once per service. Two services share one database. */
export interface ResourcesConfig {
  database?: { engine: "postgres"; version?: string };
  bucket?: boolean;
}

export interface ServiceConfig {
  name?: string;
  /** Where this service's commands run, relative to the repo root. Default ".". */
  dir?: string;
  language?: "node" | "python" | "static" | "other";
  /**
   * The interpreter or SDK this service needs — "python3.12", "node22", "java21".
   *
   * Declared rather than detected because the platform has exactly one version of
   * each and the app is the only thing that knows which it was written against.
   * Without it the pipeline notices a `requires-python >= 3.14` mismatch, logs
   * that the build will probably fail on it, and then builds anyway.
   */
  runtime?: string;
  /**
   * One token that lets the platform inject proxy-awareness — ALLOWED_HOSTS for
   * Django, basePath for Next, ROOT_PATH for FastAPI.
   *
   * This is not decoration and it is not detection-as-a-service. An app behind a
   * TLS-terminating proxy cannot configure itself for a proxy it has no way to
   * know exists, so somebody has to say which mapping applies, and only the app
   * knows.
   */
  framework?: string;
  install?: string;
  build?: string;
  /**
   * @deprecated Renamed to `release`, which says what it is. Still read.
   */
  preDeploy?: string;
  /**
   * One-shot steps that run ONCE per deploy, before any traffic — migrations,
   * above all.
   *
   * Separate from `start` because they are not the same kind of thing, and
   * conflating them has a real cost: folded into the start command, a migration
   * re-runs on every cold start and every scale-out instance, concurrently.
   * Prisma takes an advisory lock and survives that; Alembic does not.
   */
  release?: string;
  /** The long-running command. Serves HTTP on $PORT. */
  start?: string;
  /** Static only: the built directory, relative to `dir`. */
  outputDir?: string;
  /**
   * Static only: serve index.html for a path that matches no file.
   *
   * Without it a React Router app 404s on a refresh at /about, and nothing in the
   * config can say otherwise — the same directory is a correct answer for a
   * multi-page site and a broken one for an SPA, and only the author knows which.
   */
  spaFallback?: boolean;
  /** Container lane: a Dockerfile relative to the repo root. */
  dockerfile?: string;
  /** Container lane: the build context that Dockerfile expects. Default `dir`. */
  context?: string;
  /**
   * @deprecated Per-service shorthand for `resources.database`. ORs in, because
   * provisioning is once per app: a sibling that needed a database never got one
   * when the primary did not declare it.
   */
  needsDB?: boolean;
  /**
   * Which shared resources this service receives credentials for. The unit that
   * per-app database isolation is scoped to.
   */
  uses?: ("database" | "bucket")[];
  /**
   * Non-secret literals, committed, deploy-shaping. NODE_ENV, LOG_LEVEL.
   *
   * The array form is the v1 spelling — env var NAMES the service reads — and is
   * still accepted, but it lands in `envNeeded`, not here. See parseAppConfig.
   */
  env?: Record<string, string>;
  /** @deprecated v1's `env: [...]`: names the service reads. Superseded by `secrets`. */
  envNeeded?: string[];
  /**
   * Baked into the bundle at BUILD time and useless at runtime — VITE_*,
   * NEXT_PUBLIC_*. A separate field because they are set at a different moment,
   * and setting them after the build (which is what happened) means the build
   * ran without them and the value never reached the shipped JavaScript.
   */
  buildEnv?: Record<string, string>;
  /**
   * Secret NAMES, never values. Enforced: a name declared here and missing at
   * deploy time fails before the build rather than at runtime, which is where
   * `envNeeded` failed — it was logged and checked nowhere.
   */
  secrets?: string[];
  health?: HealthConfig;
  scale?: ScaleConfig;
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
  resources?: ResourcesConfig;
  services: ServiceConfig[];
}

export class ConfigError extends Error {}

const LANGUAGES = new Set(["node", "python", "static", "other"]);

/**
 * Names the platform writes, which a config may therefore not declare.
 *
 * Derived from `databaseEnv()` rather than typed out again. The two lists were
 * maintained separately once — 6 protected names against 17 written — and every
 * name in the gap was a user value the platform silently overwrote, which reads
 * to the user as their own config being ignored.
 *
 * The prefixes are deliberately broad. `PGSSLMODE` is not written by
 * `databaseEnv()` today, but it configures the same connection the platform owns,
 * and a user setting it is describing a connection they do not control. Refusing
 * it by name is a better failure than honouring it into a contradiction.
 */
const PLATFORM_OWNED_PREFIXES = [/^POSTGRES_/, /^PG/, /^DB_/, /^SUPERSONIC_/];
const PLATFORM_OWNED_EXACT = new Set([...databaseEnvNames(), "PORT"]);

export function platformOwned(name: string): boolean {
  return PLATFORM_OWNED_EXACT.has(name) || PLATFORM_OWNED_PREFIXES.some((re) => re.test(name));
}

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

function num(v: unknown, where: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ConfigError(`${where} must be a number`);
  return v;
}

/**
 * A map of literal values, rejecting any name the platform writes itself.
 *
 * Refused at PARSE time rather than at deploy time on purpose. A user who sets
 * DATABASE_URL is describing a database they do not have — the platform will
 * overwrite it — and finding that out from a build log, after provisioning, is
 * finding it out at the least useful moment. The message names the variable
 * because "invalid configuration" sends someone reading the whole file.
 */
function literals(v: unknown, where: string): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) {
    // Both spellings are named, because `env` is the one field whose meaning
    // changed between schema versions: someone hitting this may have written
    // either and deserves to be told which one they are near.
    throw new ConfigError(`${where} must be an object of NAME: value, or an array of variable NAMES`);
  }
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (platformOwned(k)) {
      throw new ConfigError(
        `${where}: "${k}" is set by the platform and cannot be declared here. ` +
        `Remove it — the value the app receives is the one the platform provisions.`,
      );
    }
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
      throw new ConfigError(`${where}.${k} must be a string, number or boolean`);
    }
    out[k] = String(raw);
  }
  return out;
}

function names(v: unknown, where: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((e) => typeof e !== "string")) {
    throw new ConfigError(`${where} must be an array of variable NAMES`);
  }
  for (const n of v as string[]) {
    if (platformOwned(n)) {
      throw new ConfigError(`${where}: "${n}" is set by the platform and cannot be declared here.`);
    }
  }
  return v as string[];
}

function health(v: unknown, where: string): HealthConfig | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`${where} must be an object`);
  const o = v as Record<string, unknown>;
  const path = str(o.path, `${where}.path`) ?? "/";
  if (!path.startsWith("/")) throw new ConfigError(`${where}.path must start with /`);
  const expect = num(o.expect, `${where}.expect`) ?? 200;
  if (expect < 100 || expect > 599) throw new ConfigError(`${where}.expect must be an HTTP status code`);
  return { path, expect };
}

function scale(v: unknown, where: string): ScaleConfig | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`${where} must be an object`);
  const o = v as Record<string, unknown>;
  const memory = str(o.memory, `${where}.memory`);
  // Caught here because Cloud Run rejects it far downstream, after provisioning,
  // with a message about a quantity rather than about this field.
  if (memory !== undefined && !/^\d+(Mi|Gi)$/.test(memory)) {
    throw new ConfigError(`${where}.memory must look like "512Mi" or "2Gi" (got ${JSON.stringify(memory)})`);
  }
  return {
    memory,
    cpu: num(o.cpu, `${where}.cpu`),
    maxInstances: num(o.maxInstances, `${where}.maxInstances`),
    timeout: num(o.timeout, `${where}.timeout`),
    concurrency: num(o.concurrency, `${where}.concurrency`),
    cpuBoost: o.cpuBoost === undefined ? undefined : Boolean(o.cpuBoost),
  };
}

function resources(v: unknown): ResourcesConfig | undefined {
  if (v === undefined || v === null) return undefined;
  const where = `${CONFIG_FILENAME} resources`;
  if (typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`${where} must be an object`);
  const o = v as Record<string, unknown>;
  let database: ResourcesConfig["database"];
  if (o.database !== undefined && o.database !== null && o.database !== false) {
    if (typeof o.database !== "object" || Array.isArray(o.database)) {
      throw new ConfigError(`${where}.database must be an object`);
    }
    const d = o.database as Record<string, unknown>;
    const engine = str(d.engine, `${where}.database.engine`) ?? "postgres";
    if (engine !== "postgres") throw new ConfigError(`${where}.database.engine: only "postgres" is provisioned today (got ${JSON.stringify(engine)})`);
    database = { engine: "postgres", version: str(d.version, `${where}.database.version`) };
  }
  return { database, bucket: o.bucket === undefined ? undefined : Boolean(o.bucket) };
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
    // `env` means two different things in two schema versions, and both are
    // accepted: v1's array is a list of NAMES the service reads, v2's object is
    // literal values to set. They land in different fields so nothing downstream
    // has to ask which it got. The array is not silently promoted to `secrets`
    // even though that is its nearest v2 relative — `secrets` is ENFORCED, and
    // turning a field that was only ever logged into one that fails the deploy
    // would break working apps on a rename.
    const envIsNameList = Array.isArray(svc.env);
    const uses = svc.uses === undefined ? undefined : names(svc.uses, `${where}.uses`);
    for (const u of uses ?? []) {
      if (u !== "database" && u !== "bucket") {
        throw new ConfigError(`${where}.uses: "${u}" is not a resource — expected "database" or "bucket"`);
      }
    }
    return {
      name: str(svc.name, `${where}.name`),
      dir: safeDir(svc.dir, where),
      language: language as ServiceConfig["language"],
      runtime: str(svc.runtime, `${where}.runtime`),
      framework: str(svc.framework, `${where}.framework`),
      install: str(svc.install, `${where}.install`),
      build: str(svc.build, `${where}.build`),
      preDeploy: str(svc.preDeploy, `${where}.preDeploy`),
      release: str(svc.release, `${where}.release`),
      start: str(svc.start, `${where}.start`),
      outputDir: str(svc.outputDir, `${where}.outputDir`),
      spaFallback: svc.spaFallback === undefined ? undefined : Boolean(svc.spaFallback),
      dockerfile: str(svc.dockerfile, `${where}.dockerfile`),
      context: svc.context === undefined ? undefined : safeDir(svc.context, `${where}.context`),
      needsDB: svc.needsDB === undefined ? undefined : Boolean(svc.needsDB),
      uses: uses as ServiceConfig["uses"],
      env: envIsNameList ? undefined : literals(svc.env, `${where}.env`),
      envNeeded: envIsNameList ? names(svc.env, `${where}.env`) : undefined,
      buildEnv: literals(svc.buildEnv, `${where}.buildEnv`),
      secrets: names(svc.secrets, `${where}.secrets`),
      health: health(svc.health, `${where}.health`),
      scale: scale(svc.scale, `${where}.scale`),
      path: str(svc.path, `${where}.path`),
    };
  });
  // Declared twice with two different meanings is the one case worth refusing
  // outright: `preDeploy` and `release` are the same field under two names, and
  // silently preferring one leaves the other looking ignored.
  for (const [i, s] of services.entries()) {
    if (s.preDeploy !== undefined && s.release !== undefined && s.preDeploy !== s.release) {
      throw new ConfigError(
        `${CONFIG_FILENAME} services[${i}]: "preDeploy" and "release" are the same field — keep "release".`,
      );
    }
  }
  // Checked here rather than at deploy time: two services claiming the same
  // prefix means one of them silently never receives a request, which is
  // indistinguishable from that service being broken.
  const seen = new Set<string>();
  for (const s of services) {
    const p = servicePath(s);
    if (seen.has(p)) throw new ConfigError(`${CONFIG_FILENAME}: two services both serve ${p}`);
    seen.add(p);
  }
  return {
    version: typeof o.version === "number" ? o.version : 1,
    resources: appResources(resources(o.resources), services),
    services,
  };
}

/**
 * The app's resources, with the per-service `needsDB` shorthand OR'd in.
 *
 * Provisioning is once per app and used to be driven by the PRIMARY service's
 * plan alone, so a static frontend on "/" with a Django API on "/api" provisioned
 * nothing: the primary declared no database, and the sibling that needed one was
 * never asked. Any service saying it needs a database is the app needing a
 * database — there is only one to share.
 */
export function appResources(declared: ResourcesConfig | undefined, services: ServiceConfig[]): ResourcesConfig | undefined {
  const wantsDb = services.some(usesDatabase);
  const wantsBucket = services.some((s) => (s.uses ?? []).includes("bucket"));
  const database = declared?.database ?? (wantsDb ? { engine: "postgres" as const } : undefined);
  const bucket = declared?.bucket ?? (wantsBucket ? true : undefined);
  if (!database && bucket === undefined) return declared;
  return { database, bucket };
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
    preRun: releaseCommand(s) ? [inDir(releaseCommand(s), dir) as string] : undefined,
    run: inDir(s.start, dir) ?? "",
    static: isStatic,
    outputDir: isStatic ? (dir === "." ? (s.outputDir ?? ".") : `${dir}/${s.outputDir ?? "."}`.replace(/\/\.$/, "")) : undefined,
    needsDB: usesDatabase(s) || undefined,
    envNeeded: s.envNeeded,
    // `source` because this same shape is now produced two ways: read out of the
    // user's file, and inferred from the repository by infer-services. Printing
    // `Plan ready: supersonic.json` for the second sends someone looking for a
    // file that is not there — the same class of defect as a confidence number
    // nothing reads.
    reason: `${source}${s.name ? ` (${s.name})` : ""}`,
  };
}

/**
 * Whether a service wants the app's database, under either spelling.
 *
 * `uses: ["database"]` is schema v2's word for what `needsDB: true` said in v1,
 * and for one deploy it meant nothing at all: the parser read it, `validate`
 * accepted it, `supersonic check` printed "uses database" — and the pipeline
 * asked `svc.needsDB`, got undefined, and provisioned no database. The app was
 * deployed with a config that said it needed Postgres and an environment that
 * had none, and the first thing to notice was a pydantic error about
 * POSTGRES_SERVER inside the release job.
 *
 * That is precisely the asymmetry this schema was written to end — a field is
 * only as real as the number of readers that happen to know about it — so the
 * two spellings answer through one function rather than being tested for
 * separately at each call site.
 */
export function usesDatabase(s: ServiceConfig): boolean {
  return Boolean(s.needsDB) || (s.uses ?? []).includes("database");
}

/** The one-shot pre-traffic command, under whichever name the file used. */
export function releaseCommand(s: ServiceConfig): string | undefined {
  return s.release ?? s.preDeploy;
}

/** The repo's config, or null when it has none. Throws ConfigError if it is unusable. */
export function readAppConfig(dir: string): AppConfig | null {
  const path = join(dir, CONFIG_FILENAME);
  if (!existsSync(path)) return null;
  return parseAppConfig(readFileSync(path, "utf8"));
}
