import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { readRepoFacts, type RepoFacts } from "./repo-facts";
import type { AppConfig, ServiceConfig } from "./app-config";

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
 */
const BROWSER_FACING = /next\.?js|nuxt|remix|sveltekit|astro|vite|create react app|static/i;

/** Where a Python ASGI/WSGI app's module usually sits, relative to its service dir. */
const PYTHON_ENTRIES = ["main.py", "app/main.py", "src/main.py", "app.py", "api/main.py", "src/app.py"];

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

/** Python entry points that mean something can be started here. */
const PYTHON_RUNNABLE = [...PYTHON_ENTRIES, "manage.py", "wsgi.py", "asgi.py"];

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
 * Rewrite a hardcoded port to `$PORT`.
 *
 * Cloud Run routes to `$PORT` and nothing else, while every one of the
 * detector's Python start commands names a literal port — `uvicorn … --port
 * 8000`, `gunicorn … --bind 0.0.0.0:8000`. A container that binds the literal
 * one never passes a health check, which surfaces to the user as the least
 * useful sentence the platform has: "didn't start on $PORT".
 */
export function bindToPort(cmd: string): string {
  return cmd
    .replace(/(--port[= ])\d+/g, "$1$PORT")
    .replace(/(--bind[= ]\S*?:)\d+/g, "$1$PORT")
    .replace(/(-b\s+\S*?:)\d+/g, "$1$PORT")
    .replace(/(-p\s+)\d+/g, "$1$PORT");
}

/**
 * The dotted module path of a Python app's entry point.
 *
 * The detector answers `main:app` for every Python project, because at the root
 * of a single-app repo it usually is. In a `backend/` whose code lives in
 * `backend/app/main.py` it is `app.main:app`, and the difference is the whole
 * deploy: uvicorn exits immediately on a module it cannot import.
 */
export function pythonModule(serviceDir: string): string | null {
  for (const entry of PYTHON_ENTRIES) {
    if (existsSync(join(serviceDir, entry))) return entry.replace(/\.py$/, "").split("/").join(".");
  }
  return null;
}

/** The production start command for one detected part, always bound to `$PORT`. */
function startFor(stack: DetectedStack, absoluteDir: string): string {
  const bound = bindToPort(stack.startCommand);
  if (!/^python/i.test(stack.language)) return bound;
  const mod = pythonModule(absoluteDir);
  // No recognisable entry point: the detector's guess, at least bound to the
  // right port. Wrong-but-honest beats inventing a module name.
  if (!mod) return bound;
  return bound.replace(/\b(?:main|app)(?=:app\b)/, mod);
}

/**
 * How to install a Python service's dependencies, from what it actually ships.
 *
 * The detector answers `pip install -r requirements.txt` for every Python
 * project, whether or not there is one — right at the root of a single-app repo
 * often enough, and wrong for the FastAPI template's backend, which is
 * pyproject.toml + uv.lock with no requirements.txt anywhere. That matters more
 * here than it looks: the runner has its own correct convention
 * (`[ -f pyproject.toml ] && pip install .`), and a plan-supplied install
 * OVERRIDES it. Inferring the detector's answer verbatim would replace a working
 * default with a command that cannot run.
 *
 * Returning undefined hands the decision back to that convention, which is the
 * right answer when neither manifest is present.
 */
export function pythonInstall(serviceDir: string, detected: string | null): string | undefined {
  if (existsSync(join(serviceDir, "requirements.txt"))) return detected ?? "pip install --no-cache-dir -r requirements.txt";
  if (existsSync(join(serviceDir, "pyproject.toml"))) return "pip install --no-cache-dir .";
  return undefined;
}

function languageOf(stack: DetectedStack): ServiceConfig["language"] {
  if (stack.serve.mode === "static") return "static";
  if (/^python/i.test(stack.language)) return "python";
  if (/^(java)?script|^typescript/i.test(stack.language)) return "node";
  return "other";
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
 * The repository's apps, or null when there is only one.
 *
 * `detect` is injected rather than imported: the detector runs as a subprocess
 * out of `services/deploy-agent`, and a module that spawns one is a module that
 * cannot be tested without spawning four.
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
