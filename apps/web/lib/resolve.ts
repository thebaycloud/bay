import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  readAppConfig, inDir, servicePath, primaryService, releaseCommand, appResources,
  CONFIG_FILENAME, ConfigError,
  type AppConfig, type ServiceConfig, type ResourcesConfig, type HealthConfig,
} from "./app-config";
import { inferAppConfig, type Detect } from "./infer-services";
import { withScale, type Lane, type Scale } from "./lanes";

/**
 * One resolved description of an app, and one place that produces it.
 *
 * "Apply the plan" was implemented seven times — five lanes plus prepare.sh and
 * entrypoint.sh — so adding a field meant finding seven readers, and nothing
 * failed when you missed one. A field was only as real as the number of lanes
 * that happened to read it: a `supersonic.json` that was present, valid,
 * hand-written and correct still failed, because it was threaded into the runner
 * lane and never the static one.
 *
 * The fix is not a better config format. It is that resolution happens once,
 * here, and everything downstream reads `ResolvedApp` and nothing else. Note in
 * particular that `lane` is DERIVED and never authored: users declare what the
 * app IS, the resolver decides how it is built, and one executor consumes the
 * decision.
 */

export interface DeploymentFacts {
  hostname: string;
  scheme: "https";
  pathPrefix: string;
  siblingUrls: Record<string, string>;
}

export interface ResolvedService {
  name: string;
  dir: string;
  path: string;
  /** Derived from what the service is. Never read from the file. */
  lane: Lane;

  runtime?: string;
  framework?: string;

  install?: string;
  build?: string;
  /** Runs ONCE, before traffic. */
  release?: string;
  start?: string;

  outputDir?: string;
  spaFallback: boolean;
  dockerfile?: string;
  context?: string;

  uses: ("database" | "bucket")[];

  env: Record<string, string>;
  buildEnv: Record<string, string>;
  /** NAMES only. Never logged, never a --update-env-vars literal. */
  secrets: string[];
  /** v1's `env: [...]`. Carried so nothing silently drops it; not enforced. */
  envNeeded: string[];

  health: HealthConfig;
  scale: Scale;

  /**
   * The fields the AUTHOR actually wrote, canonicalised.
   *
   * assert-consumed needs this and cannot work without it: every other field
   * here carries a resolver default, so "is it set?" answers yes for a service
   * whose author wrote nothing. Refusing a static site because the resolver
   * defaulted its health check would be the same silent-asymmetry bug pointed
   * the other way — this time refusing correct configs instead of ignoring
   * incorrect ones.
   */
  declared: Array<keyof ResolvedService>;
}

export interface ResolvedApp {
  source: "config" | "inferred";
  resources: ResourcesConfig;
  services: ResolvedService[];
  facts?: DeploymentFacts;
}

export class ResolveError extends Error {}

/**
 * Node and Python are INTERPRETED: source ships, dependencies install at build
 * time, and the start command runs the source — which is the prebuilt runner
 * lane's entire model, and why it can skip building an image at all.
 *
 * Go, Java, Rust and .NET are compiled and need a build toolchain that must not
 * exist at runtime. That is a two-stage build, which is what the buildpack and
 * container lanes are for. Ruby and PHP are interpreted but have no prebuilt
 * runner image here, so they take the same route.
 *
 * This is the real axis, and it is why `language: "other"` stops being a shrug
 * meaning "try buildpacks and hope".
 */
const RUNNER_RUNTIMES = [/^node/, /^python/];

/**
 * The lane, decided from what the service is.
 *
 * Order matters and encodes precedence: an author who committed a Dockerfile has
 * already said how to build this, and that outranks anything inferred about the
 * language.
 */
export function deriveLane(s: ServiceConfig): Lane {
  if (s.language === "static") return "static";
  if (s.dockerfile) return "container";
  const runtime = s.runtime ?? "";
  if (RUNNER_RUNTIMES.some((re) => re.test(runtime))) return "runner";
  if (runtime) return "buildpack";
  if (s.language === "node" || s.language === "python") return "runner";
  return "buildpack";
}

/**
 * What each lane can actually carry out.
 *
 * A field present in the resolved service that its lane does not declare is a
 * hard failure naming the field — because declaring a thing creates an
 * expectation that it takes effect, and ignored-but-present is the last silent
 * asymmetry left. A static site cannot run a migration; saying so in five
 * seconds beats discovering it at attempt seven.
 */
const LANE_CONSUMES: Record<Lane, ReadonlyArray<keyof ResolvedService>> = {
  static: ["install", "build", "outputDir", "spaFallback", "buildEnv", "env"],
  runner: ["install", "build", "release", "start", "env", "buildEnv", "secrets", "uses", "health", "scale", "runtime", "framework"],
  // No `start`: the Dockerfile's own CMD is the start command, and a second one
  // in the config would be read by nobody.
  container: ["dockerfile", "context", "release", "env", "buildEnv", "secrets", "uses", "health", "scale", "framework"],
  buildpack: ["install", "build", "release", "start", "env", "buildEnv", "secrets", "uses", "health", "scale", "runtime", "framework"],
};

/** Fields that are always meaningful and so are never "unconsumed". */
const UNIVERSAL: ReadonlyArray<keyof ResolvedService> = ["name", "dir", "path", "lane", "envNeeded", "declared"];

/**
 * Refuse a service that declared something its lane will not act on.
 *
 * Runs BEFORE anything is built, so the cost of the mistake is five seconds
 * rather than a provisioned database, a Cloud Build, and a repair agent
 * rediscovering it from `gcloud exited 1`.
 */
export function assertConsumed(s: ResolvedService): void {
  const allowed = new Set<string>([...LANE_CONSUMES[s.lane], ...UNIVERSAL]);
  const ignored = s.declared.filter((f) => !allowed.has(f as string));
  if (!ignored.length) return;
  throw new ResolveError(
    `the ${s.lane} lane does not implement: ${ignored.join(", ")}\n` +
    `  Service "${s.name}" declares ${ignored.length === 1 ? "it" : "them"} and the deploy would ignore ` +
    `${ignored.length === 1 ? "it" : "them"} silently.\n` +
    (s.lane === "static"
      ? `  Move ${ignored.length === 1 ? "it" : "them"} to a service with a \`start\` command, or remove ${ignored.length === 1 ? "it" : "them"}.`
      : `  Remove ${ignored.length === 1 ? "it" : "them"}, or change the service so this lane applies.`),
  );
}

/** Health defaults to "the root answers 200" — weak, but checked, which is new. */
function healthOf(s: ServiceConfig): HealthConfig {
  return s.health ?? { path: "/", expect: 200 };
}

/**
 * Which fields the author wrote, under their resolved names.
 *
 * The two deprecated spellings collapse into the field that replaced them, so a
 * config using `preDeploy` is refused by the same rule as one using `release` —
 * a rename must not be a way around a check.
 */
function declaredFields(s: ServiceConfig): Array<keyof ResolvedService> {
  const out: Array<keyof ResolvedService> = [];
  const set = (v: unknown) => v !== undefined && v !== null && !(typeof v === "string" && !v.trim());
  if (set(s.install)) out.push("install");
  if (set(s.build)) out.push("build");
  if (set(s.release) || set(s.preDeploy)) out.push("release");
  if (set(s.start)) out.push("start");
  if (set(s.outputDir)) out.push("outputDir");
  if (s.spaFallback) out.push("spaFallback");
  if (set(s.dockerfile)) out.push("dockerfile");
  if (set(s.context)) out.push("context");
  if (s.needsDB || (s.uses ?? []).length) out.push("uses");
  if (s.env && Object.keys(s.env).length) out.push("env");
  if (s.buildEnv && Object.keys(s.buildEnv).length) out.push("buildEnv");
  if ((s.secrets ?? []).length) out.push("secrets");
  if (set(s.health)) out.push("health");
  if (set(s.scale)) out.push("scale");
  if (set(s.runtime)) out.push("runtime");
  if (set(s.framework)) out.push("framework");
  return out;
}

/**
 * One service, fully resolved: every command already wrapped for its directory,
 * every optional field given its default, and the lane decided.
 */
function resolveService(s: ServiceConfig, index: number): ResolvedService {
  const dir = s.dir ?? ".";
  const lane = deriveLane(s);
  const name = s.name ?? (index === 0 ? "app" : `svc${index}`);
  return {
    name,
    dir,
    path: servicePath(s),
    lane,
    runtime: s.runtime,
    framework: s.framework,
    // Wrapped in a subshell here, once, rather than by each lane — see inDir for
    // why the parentheses are load-bearing.
    install: inDir(s.install, dir),
    build: inDir(s.build, dir),
    release: inDir(releaseCommand(s), dir),
    start: inDir(s.start, dir),
    // Relative to the repo root, because that is what the uploader and the
    // static lane both address.
    outputDir: s.language === "static"
      ? (dir === "." ? (s.outputDir ?? ".") : `${dir}/${s.outputDir ?? "."}`.replace(/\/\.$/, ""))
      : undefined,
    spaFallback: Boolean(s.spaFallback),
    dockerfile: s.dockerfile,
    context: s.dockerfile ? (s.context ?? dir) : undefined,
    uses: s.uses ?? (s.needsDB ? ["database"] : []),
    env: s.env ?? {},
    buildEnv: s.buildEnv ?? {},
    secrets: s.secrets ?? [],
    envNeeded: s.envNeeded ?? [],
    health: healthOf(s),
    scale: withScale(s.scale),
    declared: declaredFields(s),
  };
}

/**
 * Resolve a directory into the one description everything downstream reads.
 *
 * Two sources, one output. A config is obeyed; without one the repository is
 * inferred — and `source` records which, because "Plan ready: supersonic.json"
 * printed for an inferred plan sends someone looking for a file that is not
 * there.
 *
 * The model planner is deliberately NOT one of the sources. It was already
 * dominated in both states the author can be in: an agent that just wrote the
 * app knows the answer without reading anything, and an agent in an empty chat
 * does the same job locally with file tools, faster and on the user's tokens.
 */
export async function resolve(dir: string, detect?: Detect): Promise<ResolvedApp> {
  let config: AppConfig | null = null;
  let source: ResolvedApp["source"] = "config";

  config = readAppConfig(dir);
  if (!config) {
    if (!detect) throw new ResolveError(`${dir} has no ${CONFIG_FILENAME} and no detector was supplied — run \`supersonic init\``);
    config = await inferAppConfig(dir, detect);
    source = "inferred";
  }
  if (!config) {
    throw new ResolveError(
      `could not work out how to deploy ${dir}.\n` +
      `  Run \`supersonic init\` to write a ${CONFIG_FILENAME} draft, then check it.`,
    );
  }

  return resolveFrom(config, source);
}

/**
 * The same resolution, for a config already in memory.
 *
 * Split out because the pipeline has read and parsed the config by the time it
 * needs this, and re-reading it from disk would make the deploy able to resolve
 * something other than what it validated — two answers to one question, which is
 * the failure this module is named after.
 */
export function resolveFrom(config: AppConfig, source: ResolvedApp["source"]): ResolvedApp {
  // Primary first. The order is part of the resolved shape: the primary is the
  // service deployed as the app itself, siblings are deployed beside it.
  const primary = primaryService(config);
  const ordered = [primary, ...config.services.filter((s) => s !== primary)];

  return {
    source,
    // Normalised here rather than only in the parser, so `uses` and `needsDB`
    // mean the same thing for an INFERRED app as for a written one. Inference
    // builds an AppConfig directly and never passes through parseAppConfig, and
    // a rule that holds on one of two paths is the shape of bug this whole
    // module exists to end.
    resources: appResources(config.resources, config.services) ?? {},
    services: ordered.map(resolveService),
  };
}

/**
 * Everything that can be checked without a cloud.
 *
 * This is what makes a local dry run possible, and it is the reason the loop
 * moves from 11 minutes to 2 seconds. Each failure names the field, because the
 * alternative — which is what happens today — is a build log three stages later
 * saying "module not found".
 */
export function validate(app: ResolvedApp, dir: string): void {
  const problems: string[] = [];

  if (!app.services.length) problems.push(`${CONFIG_FILENAME}: no services to deploy`);

  const paths = new Set<string>();
  for (const s of app.services) {
    const where = `service "${s.name}"`;

    if (paths.has(s.path)) problems.push(`${where}: two services both serve ${s.path}`);
    paths.add(s.path);

    const abs = join(dir, s.dir);
    if (!existsSync(abs)) {
      problems.push(`${where}: directory "${s.dir}" does not exist`);
      // Nothing below can be checked against a directory that is not there, and
      // six more failures about it would bury the one that matters.
      continue;
    }

    if (s.lane === "static") {
      // `outputDir: "."` means two opposite things: "this folder is the site",
      // which is correct for plain HTML, and "I have no idea what this is",
      // which is what the resolver defaults to. Told apart by whether the AUTHOR
      // wrote it — a declaration versus a shrug. A build command with no
      // declared output is the second one, and publishing a raw source tree as
      // a website is a silent wrong SUCCESS, which is worse than a failure.
      if (s.build && !s.declared.includes("outputDir")) {
        problems.push(`${where}: has a build command but no outputDir — what should be published?`);
      }
      if (!s.build && s.outputDir && !existsSync(join(dir, s.outputDir))) {
        problems.push(`${where}: outputDir "${s.outputDir}" does not exist and no build command would create it`);
      }
    } else if (s.lane !== "container" && !s.start) {
      // Not asked of the container lane: its Dockerfile carries its own CMD, and
      // that is the whole reason an author committed one.
      problems.push(`${where}: the ${s.lane} lane runs a server and this service has no \`start\` command`);
    }

    if (s.dockerfile) {
      if (!existsSync(join(dir, s.dockerfile))) {
        problems.push(`${where}: dockerfile "${s.dockerfile}" does not exist`);
      }
      if (s.context && !existsSync(join(dir, s.context))) {
        problems.push(`${where}: build context "${s.context}" does not exist`);
      }
    }

    try {
      assertConsumed(s);
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
  }

  if (problems.length) {
    throw new ResolveError(problems.map((p) => `✕ ${p}`).join("\n"));
  }
}

/**
 * Which secrets are declared but have no value anywhere.
 *
 * `envNeeded` was logged at one call site and checked at none, so a missing
 * secret surfaced as a runtime crash inside the customer's app — the platform
 * knew the name was required, said so to nobody, and deployed anyway.
 */
export function missingSecrets(app: ResolvedApp, available: Iterable<string>): string[] {
  const have = new Set(available);
  const want = new Set(app.services.flatMap((s) => s.secrets));
  // An external database's URL is a required secret by construction: the app
  // declared that it has a database and named where its connection string lives,
  // and nothing else supplies one. Left out of this set it would fail at container
  // start, inside the customer's own stack trace, which is precisely where a value
  // the platform already knew was missing must not first be noticed.
  const db = app.resources.database;
  if (db?.provider === "external") want.add(db.urlFrom);
  return [...want].filter((n) => !have.has(n)).sort();
}

export { ConfigError };
