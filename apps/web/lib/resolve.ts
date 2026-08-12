import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readAppConfig, inDir, servicePath, primaryService, releaseCommand, appResources,
  CONFIG_FILENAME, ConfigError,
  type AppConfig, type ServiceConfig, type ResourcesConfig, type HealthConfig,
} from "./app-config";
import { inferAppConfig, type Detect } from "./infer-services";
import { withScale, type Lane, type Scale } from "./lanes";
import { declaredRuntime, repoRuntime, runnerServes } from "./repo-runtime";

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

  uses: ("database" | "bucket" | "redis" | "elasticsearch")[];

  /**
   * The names of the processes this service declares, if any.
   *
   * Names only, deliberately: kinds, defaults and per-kind field rules live in
   * lib/processes.ts, which knows what each Cloud Run primitive accepts. What
   * this module needs is narrower — whether the service said what it runs, which
   * is what decides whether demanding a `start` command is correct.
   */
  processes: string[];

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
 * Everything the lane decision depends on, from wherever the caller found it.
 *
 * A parameter object rather than a `ServiceConfig` because the two callers learn
 * these facts from different places and had, until now, two different answers.
 * `deriveLane` reads a config; the deploy pipeline reads a detector's stack, an
 * env flag and whether an agent supplied a run command — and so it re-derived the
 * lane inline instead of calling this, with rules that do not match.
 */
export interface LaneInputs {
  language?: ServiceConfig["language"];
  runtime?: string;
  dockerfile?: string;
  /**
   * Whether the runner lane may be chosen at all.
   *
   * `RUNNER=1` in the control plane: the lane ships dark until its base images
   * exist in Artifact Registry. Invisible to `deriveLane`, which is one of the
   * two reasons the answers diverged — a config resolving to `runner` locally
   * deployed on `buildpack` in production, and nothing said so.
   */
  runnerEnabled?: boolean;
  /**
   * An agent supplied the run command, so a committed Dockerfile is overridden.
   *
   * The other divergence. A repo Dockerfile normally wins because the author was
   * explicit — except when the deploying agent has decided how to run this, which
   * outranks a Dockerfile that may not even be self-contained (an Nx
   * `COPY dist/api` Dockerfile assumes a prior build).
   */
  runCommandSupplied?: boolean;
  /**
   * The repository asked for a runtime version the prebuilt runner does not have.
   *
   * The runner holds one Python and one Node, so an app that pins anything else
   * cannot be served by it — and the platform's answer used to be to REFUSE THE
   * DEPLOY and tell the author to "widen requires-python, or wait for the runner
   * to move". That is a platform telling a business to change its software to fit
   * the platform's single opinion.
   *
   * Routing is the answer instead: buildpacks read `.python-version`,
   * `runtime.txt`, `requires-python`, `.nvmrc` and `engines.node` themselves, so
   * the app gets the version it asked for and the platform never picks one. The
   * cost is a build measured in minutes rather than seconds, which is the correct
   * trade — the alternative is running someone's code on an interpreter they did
   * not choose.
   *
   * See lib/repo-runtime.ts, and note the direction of its conservatism: anything
   * it cannot confidently serve sets this.
   */
  runtimePinned?: boolean;
}

/**
 * The lane, decided from what the service is. THE one place that decides it.
 *
 * There were two. This function was called by the CLI and by `resolveService`,
 * and by nothing in the deploy — `deploy-pipeline.ts` derived its own lane inline
 * from a string match on the detector's runtime. So `assertConsumed` validated a
 * service against a lane the deploy might not take, and a config could resolve to
 * `runner` in `supersonic check` and deploy on `buildpack` with nobody informed.
 * The exported `ResolvedApp` was read once, after the deploy, to audit it.
 *
 * Order matters and encodes precedence: an author who committed a Dockerfile has
 * already said how to build this, and that outranks anything inferred about the
 * language — unless the deploying agent overrode it.
 */
export function laneFor(i: LaneInputs): Lane {
  if (i.language === "static") return "static";
  // Defaults to true so a plain `ServiceConfig` keeps meaning what it meant: the
  // CLI has no RUNNER flag and answers for the lane a config describes, while the
  // pipeline passes the flag it actually runs under.
  // A DOCKERFILE MEANS CONTAINER; ANYTHING ELSE MEANS BUILDPACK.
  //
  // What used to sit here was the runner: a shared prebuilt runtime that Node and
  // Python apps defaulted to, with the customer's code arriving as an encrypted
  // bundle at start. It was refused by `fleetEligibility` for exactly that reason
  // — a node handed that image runs the runner and never the app — so Cloud Run
  // was the only place it could go, and it went with Cloud Run.
  //
  // The pins went with it. `runtimePinned`, `declaredRuntime` and `runnerServes`
  // existed to answer one question — whether the runner could serve a declared
  // version — and every app now builds an image for the version it asked for, so
  // there is nothing left for a pin to demote.
  //
  // `runCommandSupplied` is gone from the decision for the same reason. An
  // agent's `--run` used to override a repository Dockerfile, because a repo
  // Dockerfile may not be self-contained and the runner could take the app
  // anyway. With no runner to fall back to, overriding it would route the app to
  // the buildpack lane — which builds no image of its own, and therefore now has
  // nowhere to run.
  return i.dockerfile ? "container" : "buildpack";
}

/** The lane a written config describes, with no deploy-time overrides applied. */
export function deriveLane(s: ServiceConfig): Lane {
  return laneFor({ language: s.language, runtime: s.runtime, dockerfile: s.dockerfile });
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
  // No `runtime`: the runner has exactly one version per language and cannot
  // honour a declared one. Listing it here is what let `runtime: "python3.12"` be
  // parsed, validated, printed back by `supersonic check` and silently ignored —
  // the precise defect assert-consumed exists to catch, committed inside
  // assert-consumed's own table. An app that pins a version is routed to the
  // buildpack lane, which does implement it.
  // No `start`: the Dockerfile's own CMD is the start command, and a second one
  // in the config would be read by nobody.
  container: ["dockerfile", "context", "release", "processes", "env", "buildEnv", "secrets", "uses", "health", "scale", "framework"],
  buildpack: ["install", "build", "release", "start", "processes", "env", "buildEnv", "secrets", "uses", "health", "scale", "runtime", "framework"],
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
  if (Object.keys(s.processes ?? {}).length) out.push("processes");
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
function resolveService(s: ServiceConfig, index: number, runtimePinned = false): ResolvedService {
  const dir = s.dir ?? ".";
  const lane = laneFor({
    language: s.language, runtime: s.runtime, dockerfile: s.dockerfile, runtimePinned,
  });
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
    processes: Object.keys(s.processes ?? {}),
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

  return resolveFrom(config, source, repoPinsRuntime(dir));
}

/**
 * Does this repository pin a runtime the prebuilt runner cannot serve?
 *
 * Read HERE, from the repo's own files, because `supersonic check` has to reach
 * the answer the deploy reaches. The config's `runtime` field is handled inside
 * `laneFor`; this is the other half — an app with `.python-version` and no
 * `runtime:` in its config would otherwise be shown "runner lane" by the CLI and
 * built on buildpacks by the server, which is the one-rule-two-readers failure
 * this module is named after, in the module named after it.
 */
export function repoPinsRuntime(dir: string): boolean {
  const read = (f: string) => {
    try { return existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : null; } catch { return null; }
  };
  const pin = repoRuntime({
    pythonVersion: read(".python-version"),
    runtimeTxt: read("runtime.txt"),
    pyproject: read("pyproject.toml"),
    nvmrc: read(".nvmrc"),
    packageJson: (() => { try { return JSON.parse(read("package.json") ?? "null"); } catch { return null; } })(),
  });
  return Boolean(pin && !runnerServes(pin));
}

/**
 * The same resolution, for a config already in memory.
 *
 * Split out because the pipeline has read and parsed the config by the time it
 * needs this, and re-reading it from disk would make the deploy able to resolve
 * something other than what it validated — two answers to one question, which is
 * the failure this module is named after.
 */
export function resolveFrom(config: AppConfig, source: ResolvedApp["source"], runtimePinned = false): ResolvedApp {
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
    services: ordered.map((svc, i) => resolveService(svc, i, runtimePinned)),
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
    } else if (s.lane !== "container" && !s.start && !s.processes.length) {
      // Not asked of the container lane: its Dockerfile carries its own CMD, and
      // that is the whole reason an author committed one.
      //
      // Nor of a service that declared its `processes`. `start` is the older
      // spelling of exactly one shape — one HTTP server on one port — and
      // demanding it from a Telegram bot is the schema telling a worker-only app
      // to pretend to be a web server, which is the thing the process model
      // exists to stop. What the processes ARE is checked by lib/processes.ts,
      // which knows what each primitive accepts.
      problems.push(
        `${where}: the ${s.lane} lane runs a server and this service has no \`start\` command\n` +
        `  If this app is a worker, a bot or a scheduled job, declare "processes" instead.`,
      );
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
