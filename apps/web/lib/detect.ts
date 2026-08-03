import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readProcfile, type ProcfileEntry } from "./procfile";
import {
  pinFor, readRuntimeFiles, resolveRuntime, runtimePins,
  RUNTIME_LANGUAGES, type RuntimeLanguage,
} from "./repo-runtime";
import type { ServiceConfig } from "./app-config";

/**
 * What this directory is, and how to build it — read from the repository, by code.
 *
 * Deterministic, synchronous, no model, no network. That is the contract and it is
 * the point: the planner takes 40–180 seconds to answer questions that are written
 * down in files it is reading, and it is on the critical path of every deploy. A
 * `Procfile` says the start command. A `pnpm-lock.yaml` says the package manager.
 * A `manage.py` says the migration command. None of that needs a model, and a
 * model asked for it will occasionally invent something else.
 *
 * THE THREE RULES, FROM docs/MAKE-DEPLOYS-WORK.md
 *
 * A proper noun may SELECT behaviour; it may never SUPPLY a value the repo already
 * answers. `FRAMEWORK_START` below is the entire proper-noun surface of this file —
 * seventeen rows saying "a repo shaped like this is started like that" — and every
 * one of them is reached only after the repo's own `Procfile`, config and
 * `scripts.start` had their turn. Versions, ports, package lists and entry points
 * come from the repository or from the user. Always.
 *
 * Every decision is a hint with a fallback. A wrong guess costs one retry, which
 * is what `confidence` is for: `guessed` tells the caller that the next step is a
 * model or a question, not a build.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * Rows 6 and 7 of the start table — "ask a model" and "ask the user" — are outside
 * this function. The signature is synchronous with no network, so a model call
 * cannot live inside it, and pretending otherwise would make every caller await
 * something that is a file read 95% of the time.
 */

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

export interface Toolchain {
  /** "python", "node", "go" … Whatever the directory declares. */
  language: string;
  /** A concrete image tag, already resolved and validated. See repo-runtime.ts. */
  version?: string;
  /** Which file said so, or "platform default". Recorded in the config write-back. */
  versionFrom?: string;
  packageManager: string;
  /**
   * The install that can run BEFORE the source is copied, so the layer caches.
   *
   * Undefined means this toolchain has nothing cacheable — see `installProject`.
   */
  install?: string;
  /**
   * The part of the install that needs the source present.
   *
   * `uv sync` and `pip install .` both build the local project, and the cached
   * layer runs before `COPY . .`. So uv's cacheable half carries
   * `--no-install-project` and the project itself is installed here, after the
   * copy. A pyproject-only Python app has no `--no-install-project` equivalent at
   * all, so it forgoes the cached layer entirely rather than emitting a Dockerfile
   * that cannot build — which is the FastAPI template's exact shape.
   */
  installProject?: string;
  build?: string;
  /**
   * Where this toolchain's commands run, relative to the repo root. `"."` is root.
   *
   * The doc specifies `""` for root; this uses `"."` because `inDir`
   * (app-config.ts:705), `deployableParts`, `serviceFor` and `ServiceConfig.dir`
   * all already do, and a second sentinel for the same idea in the module whose
   * job is to feed them is a bug waiting for a monorepo.
   */
  dir: string;
  /**
   * Where `install` runs, when that is not where everything else runs.
   *
   * Only a workspace member sets it, and it is the whole reason a workspace
   * member can build at all. npm, pnpm and yarn workspaces resolve dependencies
   * at the ROOT: the lockfile is there, `node_modules` is hoisted there, and
   * running `npm install` inside `packages/app` either fails for want of a
   * lockfile or installs a second, unhoisted copy that shadows the workspace.
   * The build and the start command still belong to the member, which is what
   * `dir` keeps saying.
   *
   * Absent means "the same place as `dir`", which is every non-workspace repo.
   */
  installDir?: string;
}

export interface BuildSpec {
  /** Ordered; `[0]` is the one that serves. A FastAPI+React repo has two. */
  toolchains: Toolchain[];
  /** = `toolchains[0].language`. */
  language: string;
  /**
   * The token `FRAMEWORK_START` matched on — `deploymentEnv`'s only source.
   *
   * Not decoration. `framework-env.ts:55-96` turns this into `ALLOWED_HOSTS`,
   * `CSRF_TRUSTED_ORIGINS`, `NEXTAUTH_URL`, `RAILS_HOSTS` and `ROOT_PATH`, and
   * states the consequence itself: Django returns 400 on EVERY request when Host
   * is not in that list, which reads as the app being down.
   */
  framework?: string;
  /** The long-running command. Absent ⇒ static, or ask. Always bound to `$PORT`. */
  command?: string;
  /** The one-shot job's command — migrations, above all. Runs before traffic moves. */
  release?: string;
  /** Set ⇒ nothing to run ⇒ static target. Relative to `toolchains[0].dir`. */
  outputDir?: string;
  database?: { engine: string; via: string };
  /** apt packages the build needs. Grows from real failures only. */
  needs: string[];
  /**
   * How this was arrived at.
   *
   * `certain`   the repository or the user said so, in as many words.
   * `inferred`  a framework signal matched and the row is one we have shipped.
   * `guessed`   nothing matched. The caller decides: a model, or a question.
   */
  confidence: "certain" | "inferred" | "guessed";
}

export interface DetectOptions {
  /**
   * `--run` / the `x-supersonic-run` header — the user typing a command at deploy
   * time. It outranks everything in the repository because it is newer than all of
   * it, and because `resolve.ts:139-147` already gives it the power to outrank a
   * committed Dockerfile.
   */
  run?: string;
  /** A `supersonic.json` service, when the app has one. */
  config?: ServiceConfig;
  /**
   * The repository root, when this directory is a service inside one.
   *
   * Version files fall back to it. A monorepo puts `.nvmrc` at the root and its
   * app in `frontend/`, and the root file is still the version the author means —
   * which the CLI's own drafting code already states and implements
   * (`packages/cli/lib/draft.js:53-58`). `repoRuntime()` in the pipeline is only
   * ever called against the root and never a service directory, so the two
   * existing readers already disagree; this is the one that has to be right,
   * because it is what a per-service `FROM` is built from.
   *
   * Derived from `rel` when omitted.
   */
  repoRoot?: string;
}

/* -------------------------------------------------------------------------- */
/* 2b — package manager → install, per directory                              */
/* -------------------------------------------------------------------------- */

interface PackageRule {
  /** The file whose presence selects this manager. */
  file: string;
  manager: string;
  install?: string;
  installProject?: string;
  /**
   * The install, when the manifest's own contents change the answer.
   *
   * Only yarn needs it, and it needs it badly — see `yarnInstall`. Takes the
   * directory so a rule can read the file it matched on.
   */
  installFor?: (dir: string) => string;
}

/**
 * `--immutable` or `--frozen-lockfile`, decided by the lockfile itself.
 *
 * Yarn 1 and Yarn Berry are different programs sharing a filename, and the flag
 * that means "do not touch the lockfile" was RENAMED between them: Berry takes
 * `--immutable` and Yarn 1 exits non-zero on it. `corepack enable` with no
 * `packageManager` field in package.json activates Yarn 1.22 — so naming Berry's
 * flag for every `yarn.lock` fails the install layer of every classic Yarn repo,
 * which is most of the large ones. Excalidraw is one.
 *
 * Berry writes a `__metadata:` block and a `version:` key at the top of the
 * lockfile; Yarn 1 writes `# yarn lockfile v1`. Reading the file is the only way
 * to know, because the filename is identical either way.
 */
function yarnInstall(dir: string): string {
  const lock = readText(dir, "yarn.lock") ?? "";
  const berry = /^__metadata:/m.test(lock) || /^\s{2}version:\s*\d/m.test(lock);
  return berry
    ? "corepack enable && yarn install --immutable"
    : "corepack enable && yarn install --frozen-lockfile";
}

/**
 * First match wins, most specific first — PER LANGUAGE, not once over the tree.
 *
 * The grouping is load-bearing. A flat list evaluated once would match a repo root
 * holding both `requirements.txt` and `pnpm-lock.yaml` on its first row and never
 * install the frontend, which is every FastAPI+React monorepo. Each language that
 * a directory declares gets its own toolchain, its own package manager and its own
 * install line.
 */
const PACKAGE_RULES: Record<RuntimeLanguage, PackageRule[]> = {
  python: [
    // `uv sync` builds the local project, and the cached layer runs before the
    // source is copied. `--no-install-project` is what lets it be cached at all.
    { file: "uv.lock", manager: "uv",
      install: "pip install --no-cache-dir uv && uv sync --frozen --no-dev --no-install-project",
      installProject: "uv sync --frozen --no-dev" },
    // `POETRY_VIRTUALENVS_CREATE=false` is not a preference, it is what makes the
    // installed packages reachable. Poetry's default is a venv under
    // `~/.cache/pypoetry/virtualenvs/<hash>` — a path nothing in the image knows,
    // and one this Dockerfile cannot put on `PATH` because the hash is computed at
    // install time. So the build was green, every dependency was installed, and
    // the container exited 127 on its own entry point. Installing into the image's
    // system python is what a container wants anyway: the isolation a venv buys is
    // already the container's job.
    { file: "poetry.lock", manager: "poetry",
      install: "pip install --no-cache-dir poetry && POETRY_VIRTUALENVS_CREATE=false poetry install --no-root --only main" },
    { file: "Pipfile.lock", manager: "pipenv",
      install: "pip install --no-cache-dir pipenv && pipenv install --deploy --system" },
    { file: "requirements.txt", manager: "pip",
      install: "pip install --no-cache-dir -r requirements.txt" },
    // No `--no-install-project` equivalent exists for `pip install .`, so this one
    // installs after `COPY . .` and forgoes the cached layer. Stated rather than
    // emitted as a Dockerfile that cannot build.
    { file: "pyproject.toml", manager: "pip", installProject: "pip install --no-cache-dir ." },
  ],
  node: [
    { file: "pnpm-lock.yaml", manager: "pnpm", install: "corepack enable && pnpm install --frozen-lockfile" },
    { file: "yarn.lock", manager: "yarn", installFor: yarnInstall },
    // bun >= 1.2 writes a TEXT lockfile. Listing only `bun.lockb` drops every
    // modern bun repo to `npm install`, which cannot install a bun workspace.
    { file: "bun.lock", manager: "bun", install: "bun install --frozen-lockfile" },
    { file: "bun.lockb", manager: "bun", install: "bun install --frozen-lockfile" },
    { file: "package-lock.json", manager: "npm", install: "npm ci" },
    // `npm ci` refuses to run without a lockfile, and a lockfile-less project is
    // the common case for the people this platform is for.
    { file: "package.json", manager: "npm", install: "npm install" },
  ],
  go: [
    { file: "go.sum", manager: "go", install: "go mod download" },
    { file: "go.mod", manager: "go", install: "go mod download" },
  ],
  rust: [
    // cargo resolves and compiles in one step; there is no install to cache apart
    // from the build itself.
    { file: "Cargo.lock", manager: "cargo" },
    { file: "Cargo.toml", manager: "cargo" },
  ],
  ruby: [
    { file: "Gemfile.lock", manager: "bundler", install: "bundle install --without development test" },
    { file: "Gemfile", manager: "bundler", install: "bundle install --without development test" },
  ],
  php: [
    { file: "composer.lock", manager: "composer", install: "composer install --no-dev --optimize-autoloader" },
    { file: "composer.json", manager: "composer", install: "composer install --no-dev --optimize-autoloader" },
  ],
  // Java is the row docs/MAKE-DEPLOYS-WORK.md Part 8 names as missing: the
  // manifest COPY has no `pom.xml` or `build.gradle*` either, so "now covers Go,
  // Ruby, Java and PHP" was false for Java out of the box. Both halves are here.
  java: [
    { file: "pom.xml", manager: "maven", install: "mvn -B -q -DskipTests dependency:go-offline" },
    { file: "build.gradle.kts", manager: "gradle" },
    { file: "build.gradle", manager: "gradle" },
  ],
};

/** Every manifest a language's rules can match, for the Dockerfile's cached COPY. */
export const PACKAGE_MANIFESTS: string[] = [
  ...new Set(RUNTIME_LANGUAGES.flatMap((l) => PACKAGE_RULES[l].map((r) => r.file))),
];

/* -------------------------------------------------------------------------- */
/* Reading one directory                                                      */
/* -------------------------------------------------------------------------- */

const readText = (dir: string, file: string): string | null => {
  try {
    const p = join(dir, file);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  } catch {
    return null;
  }
};

const readJson = (dir: string, file: string): Record<string, unknown> | null => {
  const raw = readText(dir, file);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v as Record<string, unknown> : null;
  } catch {
    return null;                       // an unparseable manifest is silence
  }
};

const hasFile = (dir: string, file: string) => {
  try { return existsSync(join(dir, file)); } catch { return false; }
};

/** The first of these that exists, or null. */
function firstPresent(dir: string, files: string[]): string | null {
  return files.find((f) => hasFile(dir, f)) ?? null;
}

/** package.json dependencies and devDependencies, as one set of names. */
function nodeDeps(pkg: Record<string, unknown> | null): Set<string> {
  const p = (pkg ?? {}) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  return new Set([...Object.keys(p.dependencies ?? {}), ...Object.keys(p.devDependencies ?? {})]);
}

/**
 * Everything a Python project names as a dependency, lowercased and normalised.
 *
 * requirements.txt and pyproject.toml, read as ONE body of text. The detector
 * already does this (`deploy-agent/src/index.ts:207`) and it is the right call:
 * which of the two a project uses is not a fact about what it depends on.
 */
function pythonDepsText(dir: string): string {
  return [
    readText(dir, "requirements.txt") ?? "",
    readText(dir, "pyproject.toml") ?? "",
    readText(dir, "Pipfile") ?? "",
  ].join("\n").toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* 2e — FRAMEWORK_START: the entire proper-noun surface                       */
/* -------------------------------------------------------------------------- */

interface FrameworkRow {
  /** Does this directory look like this framework? */
  when: (c: DirFacts) => boolean;
  /** The command, or null when the signal matched but the app is a static build. */
  start: (c: DirFacts) => string | null;
  /**
   * A server binary the command needs that the app will not have declared.
   *
   * This replaces `PYTHON_SERVERS` in plan-deps.ts — derived from the row that
   * caused it rather than kept as a global list, because the reason a name is on
   * it is always "the row below names a program the project does not install".
   */
  extra?: string;
  /** `deploymentEnv`'s only input. Absent when the row identifies no framework. */
  token?: string;
}

/** Everything the rows below are allowed to look at. Read once, per directory. */
interface DirFacts {
  dir: string;
  rel: string;
  pkg: Record<string, unknown> | null;
  deps: Set<string>;
  pythonText: string;
  nextConfig: string | null;
  astroConfig: string | null;
  svelteConfig: string | null;
  gemfile: string | null;
  composer: Record<string, unknown> | null;
  cargo: string | null;
}

const CONFIGS = {
  next: ["next.config.js", "next.config.mjs", "next.config.cjs", "next.config.ts"],
  astro: ["astro.config.mjs", "astro.config.js", "astro.config.cjs", "astro.config.ts"],
  svelte: ["svelte.config.js", "svelte.config.mjs", "svelte.config.ts"],
};

function dirFacts(dir: string, rel: string): DirFacts {
  const pkg = readJson(dir, "package.json");
  const readFirst = (names: string[]) => {
    for (const n of names) {
      const s = readText(dir, n);
      if (s) return s;
    }
    return null;
  };
  return {
    dir, rel, pkg,
    deps: nodeDeps(pkg),
    pythonText: pythonDepsText(dir),
    nextConfig: readFirst(CONFIGS.next),
    astroConfig: readFirst(CONFIGS.astro),
    svelteConfig: readFirst(CONFIGS.svelte),
    gemfile: readText(dir, "Gemfile"),
    composer: readJson(dir, "composer.json"),
    cargo: readText(dir, "Cargo.toml"),
  };
}

/**
 * Does this Astro build produce a server, or a directory of files?
 *
 * The adapter is the signal and `output:` alone is not: `output: 'server'` with no
 * adapter is a configuration error rather than a server build, and without an
 * adapter there is no `dist/server/entry.mjs` to run. Same rule the detector
 * already applies (`deploy-agent/src/index.ts:85-89`); repeated here because
 * detect() must reach the same answer without spawning it.
 */
function astroHasAdapter(src: string | null): boolean {
  const s = src ?? "";
  return /adapter\s*:/.test(s) || /@astrojs\/(node|vercel|netlify|cloudflare|deno)/.test(s);
}

/** Next only produces a static directory under `output: 'export'`. */
function nextIsExport(src: string | null): boolean {
  return /output\s*:\s*["'`]export["'`]/.test(src ?? "");
}

/**
 * `node build` requires `@sveltejs/adapter-node`, and nothing checks for it today.
 *
 * `deploy-agent/src/index.ts:155` sets `startCommand = "node build"` for every
 * `@sveltejs/kit` app unconditionally. With `adapter-static` the build writes a
 * directory of files and no `build/index.js`, so the container comes up, exits 1
 * on a module it cannot find, and the user is told the app did not listen on
 * $PORT.
 */
function svelteHasNodeAdapter(f: DirFacts): boolean {
  return f.deps.has("@sveltejs/adapter-node")
    || /@sveltejs\/adapter-node/.test(f.svelteConfig ?? "");
}

/** The Django project package — the directory holding `wsgi.py`. */
function djangoPackage(dir: string): string | null {
  // `manage.py` names it directly, and reading it beats walking the tree:
  // `os.environ.setdefault("DJANGO_SETTINGS_MODULE", "myproj.settings")`.
  const manage = readText(dir, "manage.py") ?? "";
  const declared = manage.match(/DJANGO_SETTINGS_MODULE["']\s*,\s*["']([\w.]+)["']/)?.[1];
  if (declared) return declared.split(".")[0];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(dir, e.name, "wsgi.py"))) return e.name;
    }
  } catch { /* unreadable directory contributes nothing */ }
  return null;
}

/** `package.name` from Cargo.toml — the binary cargo will have written. */
function cargoBinary(src: string | null): string | null {
  const pkgSection = (src ?? "").split(/^\s*\[/m).find((s) => s.startsWith("package]"));
  return pkgSection?.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1] ?? null;
}

/**
 * Seventeen rows. The whole proper-noun surface of this file.
 *
 * Reached only after the repository's own answers — Procfile, config,
 * `scripts.start` — have had their turn, so a row here never overrides something
 * the author wrote down. Three of them are CONDITIONAL, and the condition is not
 * the config file's presence: astro, next and svelte each have a build mode that
 * produces files rather than a server, and a miss on the condition falls to the
 * STATIC target rather than to a model. Without that, three classes of site that
 * deploy correctly today get containerised around an entrypoint the build never
 * emits.
 */
const FRAMEWORK_START: FrameworkRow[] = [
  { when: (f) => f.deps.has("next") || Boolean(f.nextConfig),
    start: (f) => (nextIsExport(f.nextConfig) ? null : "next start -p $PORT"), token: "next" },

  { when: (f) => f.deps.has("nuxt") || hasFile(f.dir, "nuxt.config.ts") || hasFile(f.dir, "nuxt.config.js"),
    start: () => "node .output/server/index.mjs", token: "nuxt" },

  // React Router 7 is Remix; the framework kept the deploy shape and changed the
  // name, and both spellings are in the wild.
  { when: (f) => f.deps.has("@react-router/serve") || f.deps.has("@react-router/node")
      || f.deps.has("@remix-run/serve") || f.deps.has("@remix-run/node"),
    start: () => "react-router-serve ./build/server/index.js", token: "remix" },

  { when: (f) => f.deps.has("astro") || Boolean(f.astroConfig),
    start: (f) => (astroHasAdapter(f.astroConfig) ? "node ./dist/server/entry.mjs" : null), token: "astro" },

  { when: (f) => f.deps.has("@sveltejs/kit") || Boolean(f.svelteConfig),
    start: (f) => (svelteHasNodeAdapter(f) ? "node build" : null), token: "svelte" },

  { when: (f) => f.deps.has("@nestjs/core"), start: () => "node dist/main.js", token: "nest" },

  { when: (f) => hasFile(f.dir, "manage.py"),
    start: (f) => `gunicorn ${djangoPackage(f.dir) ?? "config"}.wsgi:application -b :$PORT`,
    extra: "gunicorn", token: "django" },

  { when: (f) => hasFile(f.dir, "main.py") && /fastapi/.test(f.pythonText),
    start: () => "uvicorn main:app --host 0.0.0.0 --port $PORT", extra: "uvicorn", token: "fastapi" },

  { when: (f) => hasFile(f.dir, "app/main.py") && /fastapi/.test(f.pythonText),
    start: () => "uvicorn app.main:app --host 0.0.0.0 --port $PORT", extra: "uvicorn", token: "fastapi" },

  { when: (f) => hasFile(f.dir, "app.py") && /flask/.test(f.pythonText),
    start: () => "gunicorn app:app -b :$PORT", extra: "gunicorn", token: "flask" },

  { when: (f) => hasFile(f.dir, "wsgi.py"), start: () => "gunicorn wsgi:app -b :$PORT", extra: "gunicorn" },

  { when: (f) => Boolean(f.gemfile) && /rails/i.test(f.gemfile ?? ""),
    start: () => "bundle exec rails s -b 0.0.0.0 -p $PORT", token: "rails" },

  { when: (f) => hasFile(f.dir, "config.ru"), start: () => "bundle exec rackup -p $PORT -o 0.0.0.0" },

  // Only when there is a binary to run. With several main packages and no
  // convention to choose between them, nothing builds `/app/server` — so naming
  // it as the start command would be a container that exits 127 on a file the
  // build never produced.
  { when: (f) => hasFile(f.dir, "go.mod"), start: (f) => (goMainPackage(f.dir).pattern ? "/app/server" : null) },

  { when: (f) => Boolean(f.cargo),
    start: (f) => `/app/target/release/${cargoBinary(f.cargo) ?? "app"}` },

  // The two PHP rows are DEVELOPMENT servers. `php -S` and `php artisan serve` are
  // single-threaded and serialise requests, and Cloud Run's default concurrency is
  // 80 — so a burst of 80 requests queues behind one worker and the app looks
  // hung. They are here as a first-deploy default on the explicit condition that
  // `phpConcurrency` below pins concurrency to 1 for them; replacing them with
  // frankenphp or php-fpm+nginx is the real fix and is not this step's work.
  { when: (f) => hasFile(f.dir, "artisan"),
    start: () => "php artisan serve --host 0.0.0.0 --port $PORT", token: "laravel" },

  { when: (f) => hasFile(f.dir, "index.php"), start: () => "php -S 0.0.0.0:$PORT" },
];

/**
 * Does this start command serialise requests, whatever Cloud Run's concurrency says?
 *
 * Exported so the deploy stage can pin `--concurrency 1` rather than this being a
 * comment nobody acts on. Shipping `php -S` at concurrency 80 silently is the
 * failure the row above is conditional on avoiding.
 */
export function serialisesRequests(command: string | undefined): boolean {
  return /(^|\s)php\s+-S\s/.test(command ?? "") || /artisan\s+serve/.test(command ?? "");
}

/* -------------------------------------------------------------------------- */
/* Start commands — moved here from infer-services.ts                         */
/* -------------------------------------------------------------------------- */

/** Where a Python ASGI/WSGI app's module usually sits, relative to its service dir. */
export const PYTHON_ENTRIES = ["main.py", "app/main.py", "src/main.py", "app.py", "api/main.py", "src/app.py"];

/** Python entry points that mean something can be started here. */
export const PYTHON_RUNNABLE = [...PYTHON_ENTRIES, "manage.py", "wsgi.py", "asgi.py"];

/**
 * Rewrite a hardcoded port to `$PORT`.
 *
 * Cloud Run routes to `$PORT` and nothing else, while every one of the detector's
 * Python start commands names a literal port — `uvicorn … --port 8000`, `gunicorn
 * … --bind 0.0.0.0:8000`. A container that binds the literal one never passes a
 * health check, which surfaces as the least useful sentence the platform has:
 * "didn't start on $PORT".
 *
 * Applied to whatever row wins, including a Procfile's and the user's own `--run`,
 * because the file an app already ships was written for its author's laptop.
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
 * The detector answers `main:app` for every Python project, because at the root of
 * a single-app repo it usually is. In a `backend/` whose code lives in
 * `backend/app/main.py` it is `app.main:app`, and the difference is the whole
 * deploy: uvicorn exits immediately on a module it cannot import.
 */
export function pythonModule(serviceDir: string): string | null {
  for (const entry of PYTHON_ENTRIES) {
    if (existsSync(join(serviceDir, entry))) return entry.replace(/\.py$/, "").split("/").join(".");
  }
  return null;
}

/**
 * How to install a Python service's dependencies, from what it actually ships.
 *
 * Kept as its own export because `supersonic init` and `serviceFor` both ask it
 * directly. The detector answers `pip install -r requirements.txt` for every
 * Python project whether or not there is one — wrong for the FastAPI template's
 * backend, which is pyproject.toml + uv.lock with no requirements.txt anywhere.
 * Returning undefined hands the decision back to the build's own convention, which
 * is the right answer when neither manifest is present.
 */
export function pythonInstall(serviceDir: string, detected: string | null): string | undefined {
  // The same table `detect()` reads, so a lockfile is not a second opinion.
  //
  // This used to know two manifests: `requirements.txt`, else `pip install .`.
  // The FastAPI template's backend is `pyproject.toml` + `uv.lock`, so it fell to
  // the second row — replacing `uv sync --frozen --no-dev`, an install pinned to
  // a resolved dependency graph, with an unpinned resolve from PyPI. That is a
  // downgrade applied to precisely the repositories that pinned most carefully,
  // and it happened only through inference, which is the path a config-less repo
  // takes by definition.
  //
  // `install` and `installProject` are joined, because a ServiceConfig has one
  // field and both halves have to run for the environment to be complete. The
  // Dockerfile keeps them apart for the layer cache; a plan-supplied string
  // cannot, so it trades the cache for correctness.
  const rule = PACKAGE_RULES.python.find((r) => existsSync(join(serviceDir, r.file)));
  if (!rule) return undefined;
  // `requirements.txt` is the row the detector subprocess can also be right
  // about, and its answer may name a file or a flag we would not have guessed.
  if (rule.file === "requirements.txt" && detected) return detected;
  const full = [rule.install, rule.installProject].filter(Boolean).join(" && ");
  return full || undefined;
}

/**
 * A toolchain language, as `ServiceConfig.language` is allowed to spell it.
 *
 * `ServiceConfig.language` is a closed four-value union that `parseAppConfig`
 * enforces, and `detect()` answers in seven. The mapping is not a loss for the
 * five that collapse to `"other"`: `laneFor` reads `"other"` as "not the runner's
 * two languages", which routes to the container lane — where a generated
 * Dockerfile is exactly what builds them. What IS lost is the ability to write
 * `language: "go"` in a `supersonic.json`, which the config write-back will have
 * to answer for; that is Part 6's problem, not this function's.
 *
 * The `"node"` row is the one that matters today. `languageOf` matched only
 * `/^(java)?script|^typescript/i` — the detector subprocess's display names — so
 * feeding it `detect()`'s `"node"` produced `"other"` for every Node service, and
 * `laneFor` would have routed every inferred Node app off the runner.
 */
export function serviceLanguage(language: string, isStatic = false): ServiceConfig["language"] {
  if (isStatic) return "static";
  const l = (language ?? "").toLowerCase();
  if (l.startsWith("python")) return "python";
  if (l === "node" || /^(java)?script|^typescript/.test(l)) return "node";
  if (l === "static") return "static";
  return "other";
}

/* -------------------------------------------------------------------------- */
/* 2f — needs: apt packages, grown from real failures only                    */
/* -------------------------------------------------------------------------- */

/**
 * Starts nearly empty and grows from failures, never from guessing.
 *
 * The full base image (not `-slim`) already carries the compiler and headers most
 * native builds want. What is left is the handful of libraries that are not build
 * tooling, and each row here is a build that failed once with a message naming it.
 */
const NEEDS: Array<{ when: (f: DirFacts) => boolean; packages: string[] }> = [
  { when: (f) => f.deps.has("canvas"), packages: ["libcairo2-dev", "libpango1.0-dev", "libjpeg-dev"] },
  { when: (f) => /(^|\n|\s)mysqlclient/.test(f.pythonText), packages: ["default-libmysqlclient-dev", "pkg-config"] },
  { when: (f) => /(^|\n|\s)weasyprint/.test(f.pythonText), packages: ["libpango-1.0-0", "libpangoft2-1.0-0"] },
];

/* -------------------------------------------------------------------------- */
/* 2g — database                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Which database this app talks to, from the names it depends on.
 *
 * `s.database` has exactly two writers today: the detector subprocess, and the
 * planner. It is read at `deploy-pipeline.ts:1793`, gates Postgres at `:1815`, and
 * drives every one of `databaseEnv`'s 17 names, the proxy sidecar, and the
 * `proxyWait` prefix. Taking the planner off the critical path without this means
 * a Django repo that deploys today comes up with no Cloud SQL instance, no
 * `DATABASE_URL` and no proxy — a wrong success, which is the worst failure shape
 * the platform has.
 *
 * The rules are the detector's own (`deploy-agent/src/index.ts:163-169, 214-218`),
 * plus the three languages it never covered.
 */
export function detectDatabase(f: DirFacts): BuildSpec["database"] {
  const dep = (n: string) => f.deps.has(n);
  const py = (n: string) => new RegExp(`(^|[^\\w-])${n}`, "i").test(f.pythonText);

  if (dep("@prisma/client") || dep("prisma") || hasFile(f.dir, "prisma/schema.prisma")) {
    const provider = readText(f.dir, "prisma/schema.prisma")?.match(/provider\s*=\s*"(\w+)"/)?.[1];
    const engine = provider === "mysql" ? "mysql"
      : provider === "sqlite" ? "sqlite"
      : provider === "mongodb" ? "mongodb"
      : "postgres";
    return { engine, via: "Prisma" };
  }
  if (dep("drizzle-orm")) {
    return { engine: dep("mysql2") ? "mysql" : dep("better-sqlite3") ? "sqlite" : "postgres", via: "Drizzle" };
  }
  if (dep("mongoose")) return { engine: "mongodb", via: "Mongoose" };
  if (dep("typeorm")) return { engine: dep("mysql2") || dep("mysql") ? "mysql" : "postgres", via: "TypeORM" };
  if (dep("sequelize")) return { engine: dep("mysql2") || dep("mysql") ? "mysql" : "postgres", via: "Sequelize" };
  if (dep("pg") || dep("postgres")) return { engine: "postgres", via: "pg" };
  if (dep("mysql2") || dep("mysql")) return { engine: "mysql", via: "mysql" };

  if (py("psycopg2")) return { engine: "postgres", via: "psycopg2" };
  if (py("psycopg")) return { engine: "postgres", via: "psycopg" };
  if (py("asyncpg")) return { engine: "postgres", via: "asyncpg" };
  if (py("django")) return { engine: "postgres", via: "Django ORM" };
  if (py("sqlalchemy")) return { engine: "postgres", via: "SQLAlchemy" };
  if (py("pymysql") || py("mysqlclient")) return { engine: "mysql", via: "mysql" };
  if (py("pymongo")) return { engine: "mongodb", via: "pymongo" };

  const gem = f.gemfile ?? "";
  if (/^\s*gem\s+["']pg["']/m.test(gem)) return { engine: "postgres", via: "pg" };
  if (/^\s*gem\s+["']mysql2["']/m.test(gem)) return { engine: "mysql", via: "mysql2" };

  const goMod = readText(f.dir, "go.mod") ?? "";
  if (/github\.com\/lib\/pq|github\.com\/jackc\/pgx/.test(goMod)) return { engine: "postgres", via: "pgx" };
  if (/github\.com\/go-sql-driver\/mysql/.test(goMod)) return { engine: "mysql", via: "go-sql-driver" };

  const require = (f.composer?.require ?? {}) as Record<string, string>;
  if ("laravel/framework" in require) return { engine: "mysql", via: "Eloquent" };

  return undefined;
}

/* -------------------------------------------------------------------------- */
/* 2h — release                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The one-shot migration command, run once before traffic moves.
 *
 * Today `releaseCmd = releaseFromPlan(plan)` is the only assignment, so the
 * planner or a hand-written config is the only way an app gets migrations. A
 * Procfile `release:` line is explicitly NOT executed — `deploy-pipeline.ts:437`
 * logs "the Procfile declares a 'release' process and it did NOT run".
 *
 * Without these rows, a config-less Django or Alembic app deploys GREEN against an
 * unmigrated schema once the planner leaves the critical path. That is a wrong
 * success, and Part 5's classifier has no row for it because there is nothing to
 * classify.
 */
function detectRelease(f: DirFacts, procfile: ProcfileEntry[] | null, config?: ServiceConfig): string | undefined {
  const declared = config?.release ?? config?.preDeploy ?? config?.processes?.release?.command;
  if (declared?.trim()) return declared.trim();

  const fromProcfile = procfile?.find((e) => e.name === "release")?.command;
  if (fromProcfile?.trim()) return fromProcfile.trim();

  if (hasFile(f.dir, "manage.py")) return "python manage.py migrate --noinput";
  if (hasFile(f.dir, "alembic.ini")) return "alembic upgrade head";
  if (hasFile(f.dir, "prisma/schema.prisma")) return "npx --no-install prisma migrate deploy";
  if (f.gemfile && /rails/i.test(f.gemfile)) return "bundle exec rails db:migrate";
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* 2c — build                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The Go main package to build, when there is exactly one obvious answer.
 *
 * `go build -o /app/server ./...` fails on any module with more than one package:
 * `-o` pointing at a file, with a pattern matching several mains, is an error
 * rather than a choice. So the pattern is narrowed to the one main package when
 * the module has one, and only falls back to `./...` when the shape is unusual —
 * at which point `confidence` drops and the caller knows to check.
 */
/**
 * Directory names that mean "this is the server" when a module has several mains.
 *
 * `cmd/server` beside `cmd/migrate` is the ordinary Go layout, not an exotic one,
 * and it is what a real repository looks like the moment it has a migration
 * binary. Ordered: the first of these with a main package wins.
 */
const GO_SERVER_DIRS = ["server", "api", "web", "app", "service", "daemon", "http"];

export function goMainPackage(dir: string): { pattern: string | null; sure: boolean } {
  const mains: string[] = [];
  const walk = (abs: string, rel: string, depth: number) => {
    if (depth > 3 || mains.length > 8) return;
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    let isMain = false;
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".go") && !e.name.endsWith("_test.go")) {
        const src = readText(abs, e.name) ?? "";
        if (/^\s*package\s+main\s*$/m.test(src)) isMain = true;
      }
    }
    if (isMain) mains.push(rel);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".") || e.name === "vendor" || e.name === "node_modules") continue;
      walk(join(abs, e.name), rel === "." ? `./${e.name}` : `${rel}/${e.name}`, depth + 1);
    }
  };
  walk(dir, ".", 0);

  if (mains.length === 1) return { pattern: mains[0], sure: true };
  if (mains.includes(".")) return { pattern: ".", sure: true };
  const underCmd = mains.filter((m) => m.startsWith("./cmd/"));
  if (underCmd.length === 1) return { pattern: underCmd[0], sure: true };

  // Several binaries. `cmd/server` beside `cmd/migrate` is what a real Go service
  // looks like as soon as it has migrations, so this is the common case rather
  // than the exotic one, and convention answers it.
  const named = GO_SERVER_DIRS
    .map((n) => underCmd.find((m) => m === `./cmd/${n}`))
    .filter(Boolean) as string[];
  if (named.length === 1) return { pattern: named[0], sure: true };

  // Genuinely ambiguous. NOT `./...`, which is what this used to answer and which
  // is a command that cannot succeed: `-o` naming a file, with a pattern matching
  // several main packages, is an error in the Go toolchain rather than a choice.
  // Emitting a build we know fails buys a confusing build log; emitting none
  // leaves `confidence: "guessed"`, which is the caller's cue to ask.
  return { pattern: null, sure: false };
}

/**
 * Build, from the manifest — never from the framework name.
 *
 * Next, Vite, Nuxt and Remix all have `scripts.build`. That is why per-framework
 * Dockerfiles (`spaDockerfile`, `nextDockerfile`) were never necessary: they
 * encoded a build layout per product, a matrix that grows forever and is wrong the
 * moment a framework changes its output directory.
 */
function buildFor(language: RuntimeLanguage, manager: string, f: DirFacts): { build?: string; sure: boolean } {
  if (language === "node") {
    const scripts = (f.pkg?.scripts ?? {}) as Record<string, string>;
    return { build: scripts.build ? `${manager === "bun" ? "bun" : manager} run build` : undefined, sure: true };
  }
  if (language === "go") {
    const main = goMainPackage(f.dir);
    // No pattern means several binaries and no convention to pick between them.
    // No build is better than one that cannot succeed: it leaves `confidence`
    // at "guessed", which is the caller's cue to ask rather than to build.
    return main.pattern
      ? { build: `go build -o /app/server ${main.pattern}`, sure: main.sure }
      : { sure: false };
  }
  if (language === "rust") return { build: "cargo build --release", sure: true };
  if (language === "java") {
    return manager === "maven"
      ? { build: "mvn -B -DskipTests package", sure: true }
      : { build: `${hasFile(f.dir, "gradlew") ? "./gradlew" : "gradle"} --no-daemon build -x test`, sure: true };
  }
  if (language === "ruby" && f.gemfile && /rails/i.test(f.gemfile)) {
    return { build: "bundle exec rails assets:precompile", sure: true };
  }
  return { sure: true };
}

/* -------------------------------------------------------------------------- */
/* The static target                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The directory a build writes its files into, when nothing needs to run.
 *
 * A miss on one of the three conditional framework rows lands here — an Astro
 * site with no adapter, a Next app under `output: 'export'`, a SvelteKit app on
 * `adapter-static`. Those deploy correctly today on the lane Part 1 marks
 * "(unchanged)", and containerising them around an entrypoint the build never
 * emits is a regression the plan is explicit about avoiding.
 *
 * TWO ANSWERS, AND ONLY ONE OF THEM IS AUTHORITATIVE.
 *
 * The presence of a value here decides STATIC-VERSUS-SERVER, which is a proper
 * noun selecting behaviour and is exactly what rule 1 permits. The value itself
 * — `dist`, `build`, `out` — is a proper noun SUPPLYING a value the repository
 * already answers, which is what rule 1 forbids, and every one of these
 * defaults is overridable in the project's own config: Vite's `build.outDir`,
 * Astro's `outDir`, Next's `distDir`, CRA's `BUILD_PATH`, an adapter's `pages`.
 * The FastAPI full-stack template sets one, and the deploy published nothing.
 *
 * So it is a HINT and is treated as one. `static-build.ts` stamps a marker
 * before the build and, when this prediction turns out to name a directory the
 * build did not write, publishes the one it did. Do not add rows here to chase
 * a framework — Angular, Gatsby, Eleventy, Hugo, Docusaurus, VitePress and
 * Parcel all have their own answer and the list has no end. The build already
 * knows; the only correct move is to ask it.
 */
function staticOutputDir(f: DirFacts): string | undefined {
  if (f.deps.has("next")) return nextIsExport(f.nextConfig) ? "out" : undefined;
  if (f.deps.has("astro") || f.astroConfig) return astroHasAdapter(f.astroConfig) ? undefined : "dist";
  if (f.deps.has("@sveltejs/kit") || f.svelteConfig) return svelteHasNodeAdapter(f) ? undefined : "build";
  if (f.deps.has("react-scripts")) return "build";
  if (f.deps.has("vite")) return "dist";
  // A hand-written page. Its output IS the directory — `|| "dist"` here is what
  // once killed the simplest possible site with an rsync from nowhere.
  if (hasFile(f.dir, "index.html")) return ".";
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* detect()                                                                   */
/* -------------------------------------------------------------------------- */

/** Which of the seven languages this directory declares, most-declared first. */
export function languagesIn(dir: string): RuntimeLanguage[] {
  return RUNTIME_LANGUAGES.filter((l) => PACKAGE_RULES[l].some((r) => hasFile(dir, r.file)));
}

/**
 * The toolchain for one language in one directory: manager, install, build, version.
 */
function toolchainFor(
  language: RuntimeLanguage, f: DirFacts, rel: string, repoRoot: string,
): { tc: Toolchain; sure: boolean } | null {
  let rule = PACKAGE_RULES[language].find((r) => hasFile(f.dir, r.file));
  // A workspace member installs at the root, with the root's manager.
  //
  // Its own `package.json` matches the last node rule and yields `npm install` —
  // which is wrong twice over in a yarn or pnpm workspace: the wrong program, and
  // the wrong directory. The root is where the lockfile is, where `node_modules`
  // is hoisted to, and where the member's own dependencies are actually resolved
  // from. Detected on the root's `workspaces` declaration rather than on the
  // member, because that declaration is the thing that makes it a member.
  const rootInstall = language === "node" && rel !== "." && workspaceRootOf(repoRoot)
    ? PACKAGE_RULES.node.find((r) => r.install || r.installFor ? hasFile(repoRoot, r.file) : false)
    : undefined;
  // Only when the root has a REAL lockfile — a bare root `package.json` is not a
  // dependency set worth preferring over the member's own.
  const hoisted = rootInstall && rootInstall.file !== "package.json" ? rootInstall : undefined;
  if (hoisted) rule = hoisted;
  if (!rule) return null;

  const installFrom = hoisted ? repoRoot : f.dir;
  const { build, sure } = buildFor(language, rule.manager, f);

  // This directory first, then the repository root. A `backend/` with no version
  // file of its own is not a directory with no opinion — it is one whose author
  // wrote the opinion down once, at the top.
  const own = pinFor(runtimePins(readRuntimeFiles(f.dir)), language);
  const inherited = !own && repoRoot !== f.dir
    ? pinFor(runtimePins(readRuntimeFiles(repoRoot)), language)
    : null;
  const runtime = resolveRuntime(
    language,
    own ?? (inherited ? { ...inherited, from: `${inherited.from} (repo root)` } : null),
  );

  return {
    tc: {
      language,
      version: runtime.version,
      versionFrom: runtime.versionFrom,
      packageManager: rule.manager,
      install: rule.installFor ? rule.installFor(installFrom) : rule.install,
      installProject: rule.installProject,
      build,
      dir: rel,
      // The root, when the root is where the dependencies live.
      installDir: hoisted ? "." : undefined,
    },
    sure,
  };
}

/**
 * The `workspaces` declaration of a `package.json`, if it has one.
 *
 * Its presence is the whole signal: it says the real apps live somewhere else,
 * and that their dependencies are resolved here.
 */
function workspaceRootOf(dir: string): boolean {
  const pkg = readJson(dir, "package.json");
  const w = (pkg ?? {}).workspaces;
  return Array.isArray(w) ? w.length > 0 : Boolean(w && typeof w === "object");
}

/**
 * What this directory is, and how to build it.
 *
 * `dir` is absolute. `rel` is where it sits in the repository — `"."` for the
 * root, `"backend"` for a service — and every command in the returned spec is
 * expressed relative to it, because `inDir` is what wraps them and it takes the
 * same sentinel.
 */
export function detect(dir: string, options: DetectOptions = {}, rel = "."): BuildSpec {
  const { run, config } = options;
  const f = dirFacts(dir, rel);
  // `backend/api` is two levels up from the root. Derived rather than required so
  // a caller that only knows the directory still gets the root's version files.
  const repoRoot = options.repoRoot
    ?? (rel === "." ? dir : resolve(dir, ...rel.split("/").filter((s) => s && s !== ".").map(() => "..")));

  // ---- toolchains ---------------------------------------------------------
  //
  // Every language the directory declares gets one, because a FastAPI+React
  // monorepo is two and a flat answer installs one of them. Ordered so the one
  // that serves is first: the language of whatever answers HTTP.
  const present = languagesIn(dir);
  const built = present
    .map((l) => toolchainFor(l, f, rel, repoRoot))
    .filter((t): t is { tc: Toolchain; sure: boolean } => t !== null);

  // ---- the start command, in order ----------------------------------------
  let command: string | undefined;
  let framework: string | undefined;
  let extra: string | undefined;
  let confidence: BuildSpec["confidence"] = "certain";

  let procfile: ProcfileEntry[] | null = null;
  try {
    procfile = readProcfile(dir);
  } catch {
    // A malformed Procfile is refused by `readProcfile` and surfaced by the
    // config path, which owns that error message. Detection does not get to turn
    // it into a different, worse one.
    procfile = null;
  }

  // `--run` is the user typing a command at deploy time, which is newer than
  // everything in the tree. resolve.ts:139-147 already gives it the power to
  // outrank a committed Dockerfile; it outranks a Procfile for the same reason.
  const configWeb = config?.processes?.web?.command ?? config?.start;
  const procfileWeb = procfile?.find((e) => e.name === "web")?.command;
  const pkgScripts = (f.pkg?.scripts ?? {}) as Record<string, string>;
  const nodeManager = built.find((b) => b.tc.language === "node")?.tc.packageManager ?? "npm";

  // `scripts.start` is the one row of the four that is not somebody stating how
  // this is SERVED. Create React App ships `"start": "react-scripts start"` and
  // Vite templates ship `"start": "vite"` — dev servers, in repos whose build
  // writes a directory of files. Taking them would containerise a site that
  // deploys correctly today on the static lane, around a bundler in watch mode. So
  // this row yields to a static build; the three above it, where the author or the
  // user said it in as many words, do not.
  const staticDir = staticOutputDir(f);
  const scriptStart = pkgScripts.start && !staticDir ? `${nodeManager} start` : undefined;
  const declared = run?.trim() || configWeb?.trim() || procfileWeb?.trim() || scriptStart;

  if (declared) {
    command = declared;
    // The framework token still has to be found: `deploymentEnv` needs it whether
    // or not the app declared its own start command, and a path-prefixed Next
    // sibling with a declared start renders blank without NEXT_PUBLIC_BASE_PATH.
    framework = FRAMEWORK_START.find((r) => r.when(f))?.token;
  } else {
    const row = FRAMEWORK_START.find((r) => r.when(f));
    const started = row?.start(f) ?? null;
    if (row && started) {
      command = started;
      framework = row.token;
      extra = row.extra;
      confidence = "inferred";
    } else {
      framework = row?.token;
    }
  }

  if (command) command = bindToPort(command);

  // ---- static, when there is nothing to run -------------------------------
  //
  // A fact, not a guess: no start command and a directory of files. The three
  // conditional framework rows land here rather than at a model.
  const outputDir = command ? undefined : staticDir;
  if (!command && !outputDir) confidence = "guessed";

  // ---- the server binary the app will not have declared -------------------
  //
  // Derived from the row that caused it. `gunicorn app:app` is the correct way to
  // serve Flask and what every tutorial says — and gunicorn is a separate pip
  // package a project written around `flask run` does not have, so the container
  // exec'd it and died with exit 127 while the build was entirely green.
  if (extra) {
    const python = built.find((b) => b.tc.language === "python");
    if (python && !new RegExp(`(^|[^\\w-])${extra}`, "i").test(f.pythonText)) {
      // Into the SAME environment the app's own dependencies went into.
      //
      // A bare `pip install uvicorn` installs to the image's system python, and
      // uv puts the project in `/app/.venv`. Both then exist: uvicorn is on PATH
      // and starts, and immediately fails to import the app, because the
      // interpreter running it is not the one holding FastAPI. That reads as the
      // app being broken rather than as the server having been installed beside
      // it. `uv pip install` targets the project venv; poetry already installs
      // into the system python because `POETRY_VIRTUALENVS_CREATE=false` above
      // says so, so plain pip is right for every other manager.
      const into = python.tc.packageManager === "uv"
        ? `uv pip install ${extra}`
        : `pip install --no-cache-dir ${extra}`;
      // Appended to whichever half of the install runs LAST. uv's project install
      // recreates the venv, so anything added before it is discarded.
      const target = python.tc.installProject ? "installProject" : "install";
      python.tc[target] = python.tc[target] ? `${python.tc[target]} && ${into}` : into;
    }
  }

  const needs = [...new Set(NEEDS.filter((n) => n.when(f)).flatMap((n) => n.packages))];

  // A build shape we could not pin down is a hint, not an answer.
  if (built.some((b) => !b.sure) && confidence === "certain") confidence = "inferred";

  const toolchains = orderToolchains(built.map((b) => b.tc), framework, command);

  return {
    toolchains,
    language: toolchains[0]?.language ?? "static",
    framework,
    command,
    release: detectRelease(f, procfile, config),
    outputDir,
    database: detectDatabase(f),
    needs,
    confidence,
  };
}

/**
 * The toolchain that SERVES comes first, and everything else follows it.
 *
 * `toolchains[0].language` is what the rest of the pipeline reads as the app's
 * language, so getting this wrong on a FastAPI+React repo routes a Python app as
 * Node — which is the exact failure repo-facts.ts was written for. The serving
 * language is whichever one the start command actually names.
 */
function orderToolchains(toolchains: Toolchain[], framework: string | undefined, command: string | undefined): Toolchain[] {
  if (toolchains.length < 2) return toolchains;
  const cmd = command ?? "";
  const serves = (t: Toolchain): boolean => {
    if (t.language === "python") return /\b(gunicorn|uvicorn|hypercorn|daphne|granian|waitress|python3?)\b/.test(cmd);
    if (t.language === "node") return /\b(node|npm|pnpm|yarn|bun|next|nuxt|react-router-serve)\b/.test(cmd);
    if (t.language === "ruby") return /\b(bundle|ruby|rackup|rails)\b/.test(cmd);
    if (t.language === "php") return /\bphp\b/.test(cmd);
    if (t.language === "go") return /\/app\/server\b/.test(cmd);
    if (t.language === "rust") return /\/app\/target\/release\//.test(cmd);
    if (t.language === "java") return /\bjava\b/.test(cmd);
    return false;
  };
  const first = toolchains.findIndex(serves);
  if (first > 0) return [toolchains[first], ...toolchains.filter((_, i) => i !== first)];
  // No command to read yet — a static build, or a `guessed` spec. The framework
  // token is the next best signal, and after that discovery order stands.
  if (first === -1 && framework) {
    const byFramework = toolchains.findIndex((t) => t.language === (
      ["django", "fastapi", "flask"].includes(framework) ? "python"
        : ["rails"].includes(framework) ? "ruby"
        : ["laravel"].includes(framework) ? "php"
        : "node"
    ));
    if (byFramework > 0) return [toolchains[byFramework], ...toolchains.filter((_, i) => i !== byFramework)];
  }
  return toolchains;
}
