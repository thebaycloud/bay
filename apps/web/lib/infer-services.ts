import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { readRepoFacts } from "./repo-facts";
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

export type Detect = (absoluteDir: string) => DetectedStack;

/**
 * Frameworks whose job is to answer a browser. One of these owns `/`, because
 * putting the API there instead means the app's own address serves JSON.
 */
const BROWSER_FACING = /next\.?js|nuxt|remix|sveltekit|astro|vite|create react app|static/i;

/** Where a Python ASGI/WSGI app's module usually sits, relative to its service dir. */
const PYTHON_ENTRIES = ["main.py", "app/main.py", "src/main.py", "app.py", "api/main.py", "src/app.py"];

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

function languageOf(stack: DetectedStack): ServiceConfig["language"] {
  if (stack.serve.mode === "static") return "static";
  if (/^python/i.test(stack.language)) return "python";
  if (/^(java)?script|^typescript/i.test(stack.language)) return "node";
  return "other";
}

function serviceFor(relDir: string, stack: DetectedStack, absoluteDir: string): ServiceConfig {
  const language = languageOf(stack);
  const name = relDir === "." ? "app" : posix.basename(relDir);
  const base: ServiceConfig = {
    name,
    dir: relDir,
    language,
    install: stack.installCommand ?? undefined,
    build: stack.buildCommand ?? undefined,
    needsDB: stack.database?.engine ? true : undefined,
  };
  if (language === "static") {
    return { ...base, outputDir: stack.serve.mode === "static" ? stack.serve.outputDir : "dist" };
  }
  return { ...base, start: startFor(stack, absoluteDir) };
}

/**
 * The repository's apps, or null when there is only one.
 *
 * `detect` is injected rather than imported: the detector runs as a subprocess
 * out of `services/deploy-agent`, and a module that spawns one is a module that
 * cannot be tested without spawning four.
 */
export function inferAppConfig(repoDir: string, detect: Detect): AppConfig | null {
  const facts = readRepoFacts(repoDir);
  if (!facts.declarations.length) return null;

  // One entry per directory that declares anything, discovery order preserved.
  const dirs: string[] = [];
  for (const d of facts.declarations) {
    const dir = dirOf(d.from);
    if (!dirs.includes(dir)) dirs.push(dir);
  }

  // A repository whose apps live in subdirectories does not also run from its
  // root: that root is a workspace, a tooling manifest, or a uv workspace like
  // the FastAPI template's. With only one subdirectory app the root may well be
  // the other half — a root Express API beside a `frontend/` — so it stays.
  const nested = dirs.filter((d) => d !== ".");
  const parts = nested.length >= 2 || (dirs.includes(".") && isWorkspaceRoot(repoDir)) ? nested : dirs;
  if (parts.length < 2) return null;

  const detected = parts.map((rel) => {
    const abs = rel === "." ? repoDir : join(repoDir, rel);
    return { rel, abs, stack: detect(abs) };
  });

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
