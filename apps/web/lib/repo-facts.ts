import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * What the repository says about itself, before anybody guesses.
 *
 * The deploy pipeline has three opinions about what an app is: `supersonic.json`,
 * the planner agent, and the built-in detector. Two of the three are inference,
 * and on 1 Aug a FastAPI repository was deployed to the Node runner because the
 * planner returned nothing and the fallback was a detector that had already said
 * "Node · JavaScript (60%)". Nobody compared the two, and nobody looked at what
 * was lying in the repository in plain sight: a root `pyproject.toml` declaring a
 * uv workspace, and a `backend/Dockerfile` the author had written by hand.
 *
 * This module reads only facts — files that exist, and what their names mean. It
 * infers nothing and calls no model. It exists so that the pipeline can tell the
 * difference between "the repository declares Python" and "something guessed
 * Node", which is the distinction the whole failure turned on.
 *
 * Deliberately NOT a router. Knowing that `backend/Dockerfile` exists does not
 * mean the container lane can build it — a nested Dockerfile needs a build
 * context nobody has chosen yet. Reporting the fact and deciding what to do with
 * it are separate jobs, and conflating them is how a "the author was explicit"
 * rule ends up building the wrong directory.
 */

export type DeclaredLanguage = "node" | "python" | "go" | "rust" | "ruby" | "php" | "java";

export interface Declaration {
  language: DeclaredLanguage;
  /** Repo-relative path of the manifest that declares it, e.g. `backend/pyproject.toml`. */
  from: string;
  /** True when the manifest sits at the repository root. */
  root: boolean;
}

export interface RepoFacts {
  /** Every language manifest found, shallowest first. */
  declarations: Declaration[];
  /** Repo-relative paths of every `Dockerfile`, shallowest first. */
  dockerfiles: string[];
}

/**
 * Manifest filename → the language it declares.
 *
 * A lockfile counts. `uv.lock` without `pyproject.toml` is not a shape anyone
 * ships deliberately, but half a signal is still a signal, and the cost of
 * reading one extra name is nothing next to the cost of routing a Python app
 * into a Node runner.
 */
const MANIFESTS: Record<string, DeclaredLanguage> = {
  "package.json": "node",
  "pyproject.toml": "python",
  "requirements.txt": "python",
  "Pipfile": "python",
  "setup.py": "python",
  "uv.lock": "python",
  "go.mod": "go",
  "Cargo.toml": "rust",
  "Gemfile": "ruby",
  "composer.json": "php",
  "pom.xml": "java",
  "build.gradle": "java",
  "build.gradle.kts": "java",
};

/**
 * Directories that never contain a declaration ABOUT THIS APP.
 *
 * `node_modules` is the important one: it holds thousands of `package.json`
 * files, every one of them describing somebody else's library. Walking into it
 * would turn every repository on earth into a Node repository.
 */
const SKIP = new Set([
  "node_modules", ".git", ".venv", "venv", "__pycache__", "vendor",
  "dist", "build", "target", ".next", ".nuxt", ".output", "coverage",
  ".terraform", "site-packages",
]);

/**
 * How deep to look. Three levels reaches `backend/`, `services/api/`, and
 * `apps/web/` — the shapes people actually build — without walking a monorepo's
 * entire history of examples and fixtures.
 */
const MAX_DEPTH = 3;

/**
 * Read what the repository declares about itself. Never throws: a directory that
 * cannot be read contributes nothing rather than failing the deploy.
 */
export function readRepoFacts(dir: string): RepoFacts {
  const declarations: Declaration[] = [];
  const dockerfiles: string[] = [];

  // Breadth-first, so shallower declarations come first and a caller can treat
  // "the first one" as "the most authoritative" without sorting.
  let frontier: Array<{ abs: string; rel: string; depth: number }> = [{ abs: dir, rel: "", depth: 0 }];

  while (frontier.length) {
    const next: typeof frontier = [];
    for (const cur of frontier) {
      let entries;
      try {
        entries = readdirSync(cur.abs, { withFileTypes: true });
      } catch {
        continue; // unreadable directory: not a reason to fail a deploy
      }
      for (const e of entries) {
        const rel = cur.rel ? `${cur.rel}/${e.name}` : e.name;
        // `isDirectory()` and `isFile()` are both false for a symlink, which is
        // exactly what we want: the FastAPI template ships four dangling
        // symlinks into a `.venv` that does not exist in a fresh clone, and
        // following them is how the source upload used to crash (aa333df).
        if (e.isDirectory()) {
          if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
          if (cur.depth + 1 <= MAX_DEPTH) next.push({ abs: join(cur.abs, e.name), rel, depth: cur.depth + 1 });
          continue;
        }
        if (!e.isFile()) continue;
        // Exact name only. `Dockerfile.playwright` and `Dockerfile.dev` are
        // tooling, not the thing this app is served by, and treating them as a
        // deploy recipe would be a guess — which is the one thing this module
        // does not do.
        if (e.name === "Dockerfile") dockerfiles.push(rel);
        const language = MANIFESTS[e.name];
        if (language) declarations.push({ language, from: rel, root: cur.depth === 0 });
      }
    }
    frontier = next;
  }

  return { declarations, dockerfiles };
}

/** The distinct languages the repository declares, shallowest first. */
export function declaredLanguages(facts: RepoFacts): DeclaredLanguage[] {
  const seen = new Set<DeclaredLanguage>();
  for (const d of facts.declarations) seen.add(d.language);
  return [...seen];
}

/**
 * Does the repository contradict `guess`?
 *
 * Returns the declarations that disagree, or an empty array when there is no
 * disagreement — including when the repository declares nothing at all, which is
 * not disagreement but silence.
 *
 * A repository declaring several languages does not contradict any of them: a
 * Next frontend beside a FastAPI backend genuinely is both, and picking either
 * is defensible. What is NOT defensible is picking a language the repository
 * never mentions, which is precisely what happened to `y7ux3` — routed to Node
 * on the strength of a `package.json` that belonged to the frontend, with the
 * root `pyproject.toml` unread.
 */
export function contradictions(facts: RepoFacts, guess: string): Declaration[] {
  const lang = normalizeLanguage(guess);
  if (!lang) return [];
  if (!facts.declarations.length) return [];
  if (facts.declarations.some((d) => d.language === lang)) return [];
  return facts.declarations;
}

/**
 * Map a detector runtime string ("nodejs20", "python3.12") onto a declared
 * language. Returns null for anything unrecognised, so an unknown runtime is
 * treated as "no opinion" rather than as a contradiction with everything.
 */
export function normalizeLanguage(runtime: string): DeclaredLanguage | null {
  const r = String(runtime || "").toLowerCase();
  if (!r) return null;
  if (r.startsWith("node")) return "node";
  if (r.startsWith("python")) return "python";
  if (r.startsWith("go")) return "go";
  if (r.startsWith("rust")) return "rust";
  if (r.startsWith("ruby")) return "ruby";
  if (r.startsWith("php")) return "php";
  if (r.startsWith("java")) return "java";
  return null;
}
