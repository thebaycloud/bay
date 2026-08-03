import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { readRepoFacts, type RepoFacts } from "./repo-facts";
import {
  PYTHON_ENTRIES, PYTHON_RUNNABLE, bindToPort, detect, pythonInstall, pythonModule,
  serviceLanguage, type BuildSpec,
} from "./detect";
import type { AppConfig, ServiceConfig } from "./app-config";

/**
 * Re-exported, not re-implemented.
 *
 * These five moved into `detect.ts`, which is where the rules they encode now
 * live. They stay visible from here because `packages/cli/src/resolver.entry.ts`
 * imports them from this path and esbuild resolves that at bundle time — so
 * moving them without this line breaks `npm run bundle`, which `prepublishOnly`
 * runs, which is the CLI's publish gate. One implementation, two import paths, no
 * copy.
 */
export { PYTHON_ENTRIES, PYTHON_RUNNABLE, bindToPort, pythonInstall, pythonModule };

/**
 * Working out that a repository is more than one app.
 *
 * The measurement this module exists for: on 1 Aug the detector read the root of
 * a `frontend/` + `backend/` repository as "Static site, 80% confidence" — its
 * *highest* confidence answer, and completely wrong. Pointed at `frontend/` and
 * `backend/` separately, the same detector returned "Vite (SPA), 95%" and
 * "FastAPI, 90%", both correct.
 *
 * So the detector is not the broken part. It is being pointed at the wrong
 * directory. Everything here follows from that: find the directories that are
 * actually apps, run the existing detector on each, and assemble the answers.
 * No new inference, no model, no framework matrix.
 *
 * The output is an `AppConfig` — the same shape `supersonic.json` parses into —
 * because the pipeline already knows how to deploy one of those: a primary
 * service on `/`, siblings on their own path prefixes, routed by the proxy
 * (`services/proxy/src/routes.ts`). That half shipped on 31 Jul and has been
 * reachable only by hand-writing a config file. This connects it to inference.
 *
 * Declining is a first-class answer. A single-app repository returns null and
 * takes exactly the route it takes today; this can only add deploys that
 * currently fail, never change one that works.
 */

/** The part of the detector's answer this module reads. */
export interface DetectedStack {
  language: string;
  framework: string;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string;
  serve: { mode: "static"; outputDir: string } | { mode: "container" };
  database?: { engine: string | null; via?: string | null };
}

/**
 * Async because the real one spawns the deploy-agent as a subprocess, the same
 * way the pipeline's own detect stage does. A synchronous version would block
 * the control plane's event loop once per service.
 */
export type Detect = (absoluteDir: string) => Promise<DetectedStack>;

/**
 * Frameworks whose job is to answer a browser. One of these owns `/`, because
 * putting the API there instead means the app's own address serves JSON.
 *
 * Matched on substrings rather than on product names: the detector subprocess
 * spells them `"Next.js"` and `"SvelteKit"`, and `detect()` spells them `"next"`
 * and `"svelte"` because those are the tokens `frameworkEnv` routes on. The old
 * `next\.?js` and `sveltekit` alternatives matched only the first vocabulary, so
 * a repo whose frontend `detect()` identified would have lost the primary slot to
 * whichever directory happened to declare first — putting the API on the app's
 * own address, which is exactly what the comment below exists to prevent.
 */
const BROWSER_FACING = /next|nuxt|remix|svelte|astro|vite|create react app|static/i;

/**
 * Directory names that hold a manifest but never an app.
 *
 * This is the false positive that would do real damage. Almost every serious
 * repository has an `e2e/` or `tests/` with a package.json of its own, and
 * reading one as a service takes a single-app repo that deploys today and
 * routes half its traffic to Playwright. Matched on any path segment, so
 * `apps/e2e` is caught as well as `e2e`.
 */
const NOT_AN_APP = new Set([
  "e2e", "test", "tests", "spec", "specs", "docs", "doc", "examples", "example",
  "fixtures", "scripts", "tools", "infra", "terraform", "deploy", "deployment",
  "ci", "benchmark", "benchmarks", "bench", "migrations", "seeds",
]);

/** Node frameworks that are an app even when the scripts are unconventional. */
const NODE_FRAMEWORK = /^(next|nuxt|astro|vite|@remix-run\/|@sveltejs\/kit|@nestjs\/core|express|fastify|koa|hono)/;

/** The directory a manifest sits in, repo-relative. `"."` for the root. */
function dirOf(manifestPath: string): string {
  const i = manifestPath.lastIndexOf("/");
  return i === -1 ? "." : manifestPath.slice(0, i);
}

/**
 * Is this root `package.json` a workspace root rather than an app?
 *
 * `"workspaces"` is a declaration that the real apps live somewhere else. Reading
 * it as an app deploys the monorepo root — which installs everything and starts
 * nothing.
 */
function isWorkspaceRoot(repoDir: string): boolean {
  const p = join(repoDir, "package.json");
  if (!existsSync(p)) return false;
  try {
    return Boolean(JSON.parse(readFileSync(p, "utf8")).workspaces);
  } catch {
    return false;
  }
}

/**
 * Is there an app in this directory at all?
 *
 * Name lists only catch the conventions people happen to follow, so the second
 * half is the one doing the work: a package with neither a build nor a start
 * script, and no framework, has nothing to deploy whatever it is called. For
 * Python the test is an entry point — without one there is no module name to
 * pass uvicorn, so a service inferred here could only ever crash on boot.
 */
export function isDeployablePart(absoluteDir: string, relDir: string): boolean {
  if (relDir.split("/").some((seg) => NOT_AN_APP.has(seg.toLowerCase()))) return false;

  const pkgPath = join(absoluteDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const scripts = pkg.scripts ?? {};
      if (scripts.build || scripts.start) return true;
      const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
      return deps.some((d) => NODE_FRAMEWORK.test(d));
    } catch {
      return false; // unparseable manifest: not something to deploy on a guess
    }
  }

  return PYTHON_RUNNABLE.some((entry) => existsSync(join(absoluteDir, entry)));
}

/**
 * The production start command for one detected part, always bound to `$PORT`.
 *
 * The module correction must be IDEMPOTENT, and it was not. It replaced the last
 * segment before `:app` — written when the only producer was the detector
 * subprocess, which answers a bare `main:app` for every Python project whatever
 * the layout. `detect()` answers `app.main:app` for a `backend/app/main.py`
 * because it looked, and running the old rule over that produced
 * `uvicorn app.app.main:app` — a module that does not exist, from two corrections
 * that were each individually right.
 *
 * So the whole dotted path is replaced rather than its tail, which makes the
 * second application a no-op and leaves the first behaving exactly as it did.
 */
function startFor(stack: DetectedStack, absoluteDir: string): string {
  const bound = bindToPort(stack.startCommand);
  if (!/^python/i.test(stack.language)) return bound;
  const mod = pythonModule(absoluteDir);
  // No recognisable entry point: the detector's guess, at least bound to the
  // right port. Wrong-but-honest beats inventing a module name.
  if (!mod) return bound;
  // `:app\b` and not `:app`, so `gunicorn myproj.wsgi:application` is untouched.
  return bound.replace(/[\w.]+(?=:app\b)/, mod);
}

/**
 * `ServiceConfig.language` for one detected part.
 *
 * The mapping moved to `detect.ts` because there are now two vocabularies to
 * satisfy: the detector subprocess's display names (`"TypeScript"`, `"Python"`)
 * and `detect()`'s toolchain names (`"node"`, `"python"`, `"go"`, …). The rule
 * that only knew the first turned every `detect()`-produced Node service into
 * `"other"`, which `laneFor` reads as "not one of the runner's two languages" —
 * so an inferred Node app would have been routed off the runner by a string
 * comparison nobody would have thought to look at.
 */
function languageOf(stack: DetectedStack): ServiceConfig["language"] {
  return serviceLanguage(stack.language, stack.serve.mode === "static");
}

/**
 * Exported for `supersonic init`, which has to answer for a ONE-part repository
 * as well — and there is no version of that answer worth writing twice. Every
 * mapping below is a correction of the detector that took a real deploy to find
 * (`$PORT`, `app.main:app`, uv without requirements.txt); a second copy in the
 * CLI would keep exactly one of them up to date.
 */
export function serviceFor(relDir: string, stack: DetectedStack, absoluteDir: string): ServiceConfig {
  const language = languageOf(stack);
  const name = relDir === "." ? "app" : posix.basename(relDir);
  const base: ServiceConfig = {
    name,
    dir: relDir,
    language,
    install: language === "python"
      ? pythonInstall(absoluteDir, stack.installCommand)
      : stack.installCommand ?? undefined,
    build: stack.buildCommand ?? undefined,
    needsDB: stack.database?.engine ? true : undefined,
  };
  if (language === "static") {
    return { ...base, outputDir: stack.serve.mode === "static" ? stack.serve.outputDir : "dist" };
  }
  return { ...base, start: startFor(stack, absoluteDir) };
}

/**
 * The directories of this repository that are apps, in discovery order.
 *
 * Extracted from inferAppConfig rather than copied for it, because `supersonic
 * init` asks the same question and acts on a different answer: inference declines
 * below two parts, and init still has to write a file for the one part it found.
 * A repo whose only app is `backend/` returned null here and had nothing to hand
 * the CLI — which would have made "just re-derive the list in packages/cli" the
 * obvious move, and a second copy of this rule is the drift this whole module
 * exists to end.
 */
export function deployableParts(repoDir: string, facts: RepoFacts): string[] {
  // One entry per directory that declares anything AND has something to run,
  // discovery order preserved.
  const dirs: string[] = [];
  for (const d of facts.declarations) {
    const dir = dirOf(d.from);
    if (dirs.includes(dir)) continue;
    if (!isDeployablePart(dir === "." ? repoDir : join(repoDir, dir), dir)) continue;
    dirs.push(dir);
  }

  // A repository whose apps live in subdirectories does not also run from its
  // root: that root is a workspace, a tooling manifest, or a uv workspace like
  // the FastAPI template's. With only one subdirectory app the root may well be
  // the other half — a root Express API beside a `frontend/` — so it stays.
  const nested = dirs.filter((d) => d !== ".");
  return nested.length >= 2 || (dirs.includes(".") && isWorkspaceRoot(repoDir)) ? nested : dirs;
}

/**
 * A `BuildSpec` in the shape `serviceFor` and `inferAppConfig` already read.
 *
 * The doc says `serviceFor`/`isDeployablePart` "rewire onto `detect()`". Half of
 * that is right and half of it cannot be done, so this is the half that can.
 *
 * `isDeployablePart` does NOT rewire: `detect()` has no way to answer "this
 * directory is not an app". `BuildSpec` has no negative, and pointed at `e2e/` or
 * `fixtures/` it returns a perfectly valid static answer — which is precisely the
 * false positive `NOT_AN_APP` exists to catch and that two tests pin to null.
 * That question stays here, where its two tables live.
 *
 * `serviceFor` does rewire, through this adapter, and the adapter is where four
 * contracts a direct swap would have broken are kept:
 *
 * - `startCommand` is a REQUIRED string here and optional on a BuildSpec.
 *   `serviceFor` → `startFor` → `bindToPort` dereferences it unconditionally, and
 *   it runs OUTSIDE `inferAppConfig`'s try/catch — so a repo that declines
 *   cleanly today would have failed the deploy instead.
 * - `framework` is optional on a BuildSpec and is the SOLE input to primary-
 *   service selection. Absent, `findIndex` returns -1, `Math.max(0, -1)` picks
 *   index 0, and the first declared directory silently owns `/`.
 * - `serve.mode` is what decides static-ness downstream, not `outputDir`; the
 *   dependency is inverted here rather than at every reader.
 * - `database` keeps its engine and via. `serviceFor` reduces it to `needsDB`,
 *   but Part 3 needs the engine to decide the `proxyWait` prefix, so it must
 *   survive the trip even though `ServiceConfig` has nowhere to put it.
 */
export function stackFromSpec(spec: BuildSpec): DetectedStack {
  const primary = spec.toolchains[0];
  const isStatic = spec.command === undefined && spec.outputDir !== undefined;
  return {
    language: primary?.language ?? "static",
    // Never empty: a missing token hands `/` to whichever directory declared
    // first. "Static site" is what the detector answers for the same shape, and
    // BROWSER_FACING matches it.
    framework: spec.framework ?? (isStatic ? "static site" : primary?.language ?? "unknown"),
    installCommand: [primary?.install, primary?.installProject].filter(Boolean).join(" && ") || null,
    buildCommand: primary?.build ?? null,
    // `bindToPort` is applied inside detect(); an empty string here means "we did
    // not work it out", which `serviceFor` turns into a service with no start —
    // the same thing `confidence: "guessed"` says.
    startCommand: spec.command ?? "",
    serve: isStatic ? { mode: "static", outputDir: spec.outputDir ?? "." } : { mode: "container" },
    database: spec.database ? { engine: spec.database.engine, via: spec.database.via } : undefined,
  };
}

/**
 * `detect()` as the injectable `Detect`, with no subprocess and no model.
 *
 * Async only to satisfy the type: everything inside is a file read. The signature
 * stays a promise because `inferAppConfig`'s callers already await it and because
 * the deploy-agent subprocess is still a legal `Detect` during the migration —
 * two implementations of the same interface is the point of the interface.
 */
export function detectorFromFiles(repoRoot: string): Detect {
  return async (absoluteDir: string) => {
    const rel = absoluteDir === repoRoot ? "." : posix.relative(repoRoot, absoluteDir);
    return stackFromSpec(detect(absoluteDir, { repoRoot }, rel || "."));
  };
}

/**
 * The repository's apps, or null when there is only one.
 *
 * `detect` is injected rather than imported: the detector runs as a subprocess
 * out of `services/deploy-agent`, and a module that spawns one is a module that
 * cannot be tested without spawning four. `detectorFromFiles` above is the
 * deterministic implementation of the same interface.
 */
export async function inferAppConfig(repoDir: string, detect: Detect): Promise<AppConfig | null> {
  const facts = readRepoFacts(repoDir);
  if (!facts.declarations.length) return null;

  // The pipeline already holds this rule one level down: "A project that ships
  // its own Dockerfile always takes a container lane, whatever the detector
  // concluded. The author was explicit." Splitting such a repo would put an
  // inference above an instruction, which is the exact inversion this module
  // exists to stop. A Dockerfile deeper in the tree says nothing about the whole.
  if (facts.dockerfiles.includes("Dockerfile")) return null;

  const parts = deployableParts(repoDir, facts);
  if (parts.length < 2) return null;

  // A part we could not read is a part we cannot deploy, so the whole split is
  // off — but the DEPLOY is not. Inference is an upgrade, never a prerequisite:
  // declining hands the repo back to the path it takes today, while throwing
  // would make having this module worse than not having it.
  let detected;
  try {
    detected = await Promise.all(parts.map(async (rel) => {
      const abs = rel === "." ? repoDir : join(repoDir, rel);
      return { rel, abs, stack: await detect(abs) };
    }));
  } catch {
    return null;
  }

  // Whatever answers a browser owns the app's own address. With no such part —
  // two APIs, say — the first declared one does, so the app still has something
  // on `/`.
  const primaryIdx = Math.max(0, detected.findIndex((p) => BROWSER_FACING.test(p.stack.framework)));
  const ordered = [detected[primaryIdx], ...detected.filter((_, i) => i !== primaryIdx)];

  const services = ordered.map((p, i) => {
    const svc = serviceFor(p.rel, p.stack, p.abs);
    if (i === 0) return { ...svc, path: "/" };
    // One sibling is the API, and `/api` is what a frontend written by a coding
    // agent already calls. Several siblings cannot all be that, so they are
    // named for the directory they came from.
    return { ...svc, path: ordered.length === 2 ? "/api" : `/${svc.name}` };
  });

  return { version: 1, services };
}
