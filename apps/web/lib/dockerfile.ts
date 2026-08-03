import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertValidTag } from "./repo-runtime";

/**
 * Build any language, at any version, by writing the Dockerfile the app implies.
 *
 * TWO LIMITS, ONE CAUSE
 *
 * The platform could not run an app on the version it asked for, and could not run
 * several languages at all. Both come from the same place: every build path we had
 * needs someone to have prepared a runtime in advance.
 *
 *   the runner    two images exist — Python 3.14 and Node 24 — because someone
 *                 built two Dockerfiles. Every app on the fast path shares them.
 *   buildpacks    Google's builder covers Node, Python, Go, Java, Ruby, PHP and
 *                 .NET, and no Rust, Elixir, Deno or Bun. Its Python is 3.13 and
 *                 3.14 only, which is how an app pinning 3.12 failed after routing
 *                 to it correctly.
 *
 * A Dockerfile has neither limit, because Docker Hub already holds an official
 * image for every language at every version any of them ever published. `FROM
 * python:3.12` exists. So does `FROM rust:1.83`, `FROM elixir:1.17`, `FROM
 * denoland/deno:2.1`. Nobody has to prepare anything, and the platform stops being
 * the thing that decides what an app may run on.
 *
 * WHY THIS IS NOT THE HARDCODE WE DELETED
 *
 * `spaDockerfile` and `nextDockerfile` are being removed, and they also generated
 * Dockerfiles. The difference is what they encoded: they named products, with
 * per-framework build layouts and output directories, which is a matrix that grows
 * forever and is wrong the moment a framework changes.
 *
 * This names a language and takes its version from the app's own file. The base
 * image is a registry lookup — Docker Hub's official image for a language is that
 * language's name in nearly every case — and it is a DEFAULT the app can override.
 * There is no framework here, no build layout, and no version of our own.
 *
 * WHAT CHANGED WHEN THIS BECAME THE ONLY BUILD PATH
 *
 * It fired for almost nobody: `deploy-pipeline.ts:1596` reaches it only when a
 * repo pins a version the runner cannot serve. Three of its shortcuts were
 * survivable at that volume and are not survivable as the default.
 *
 *  - The manifest COPY was twenty bare globs, root-relative, in one instruction.
 *    See MANIFESTS below: zero matches is a hard build failure rather than a skip,
 *    and a monorepo's `backend/requirements.txt` was never copied at all.
 *  - One toolchain. A repository with a Python API beside a JavaScript frontend is
 *    two, and installing one of them is a container that cannot start.
 *  - No wait for the database proxy, no PATH for the interpreters it installs, and
 *    nothing to stop a `prepare` hook that needs git from failing the install.
 */

/** One language's install and build, rooted at one directory. */
export interface DockerfileToolchain {
  /** "python" | "node" | "go" | … — whatever the repo declares. Never enumerated by us. */
  language: string;
  /** A concrete tag, already resolved and validated. See repo-runtime.ts. */
  version?: string;
  /**
   * Which file chose that version, or "platform default".
   *
   * Carried through so the generated file can say it. A person reading a
   * Dockerfile they did not write asks "why this version" first, and "platform
   * default" is the only answer they did not choose — and therefore the only one
   * that can move under them.
   */
  versionFrom?: string;
  /** The install that can run before the source is copied, so the layer caches. */
  install?: string;
  /** The part of the install that needs the source present. Runs after `COPY . .`. */
  installProject?: string;
  build?: string;
  /** Relative to the build context. `"."` is the root. */
  dir: string;
}

/** How the app's dependencies and start command are already resolved elsewhere. */
export interface DockerfileInput {
  /** "python" | "node" | "go" | … — the language that SERVES. */
  language: string;
  /** Exactly what the repo's own file said, resolved to a tag. "3.12", "22", "1.83". */
  version?: string;
  /** The base image, when the app would rather choose. Skips everything below. */
  image?: string;
  install?: string;
  build?: string;
  /** The command the container runs. From `start` or the web process. */
  command: string;
  /** Files never copied into the image. See DEFAULT_IGNORE. */
  ignore?: string[];
  /**
   * Every language this app builds, the serving one first.
   *
   * When absent, the flat `language`/`version`/`install`/`build` above are read as
   * a single root toolchain — which is every caller that existed before monorepos
   * had to work.
   */
  toolchains?: DockerfileToolchain[];
  /**
   * apt packages the build needs, from `BuildSpec.needs`.
   *
   * Debian's, because every image in OFFICIAL is Debian- or Ubuntu-based. An app
   * that sets its own `image` to something else gets no apt layer worth having,
   * which is why `needs` is grown from failures rather than guessed.
   */
  needs?: string[];
  /**
   * Dependency manifests that EXIST, repo-relative. See `manifestPaths`.
   *
   * Empty or absent moves `COPY . .` ahead of the install: the layer cache is lost
   * and the build works, which is the right way round.
   */
  manifests?: string[];
  /**
   * A shell prefix for the command — `proxyWait()`, when a database was provisioned.
   *
   * `--depends-on` orders container START, not port readiness, so an app that
   * connects at import time can lose the race against the proxy binding and die on
   * "connection refused" — a failure indistinguishable from a database that does
   * not exist.
   */
  waitFor?: string;
  /**
   * Env var names the install and build steps need, mounted rather than baked.
   *
   * The reason this exists at all is written at `runnerPrepareConfig`: Prisma 7
   * evaluates `env('DATABASE_URL')` while loading prisma.config.js on EVERY cli
   * command, so `prisma generate` died on an app whose database the platform had
   * just provisioned. The runner is the only build path that ever mounted one, and
   * it is being deleted.
   *
   * `RUN --mount=type=secret` and NOT `ARG`: an arg's value is readable in image
   * history, and these images go to a shared repository, export a `mode=max` cache
   * holding more layers than the image, and are never deleted.
   */
  buildSecrets?: string[];
  /**
   * Public build-time values, baked in as `ARG`.
   *
   * `NEXT_PUBLIC_*` and friends have to be present when the bundler runs or the
   * value never reaches the shipped JavaScript — setting them afterwards, which is
   * what happened, means the build ran without them. Nothing secret belongs here;
   * see `buildSecrets`.
   */
  buildArgs?: string[];
}

/**
 * Docker Hub's official image for a language.
 *
 * A registry lookup, not an opinion: for almost every language the official image
 * is the language's own name, and the two that are not — Deno and Bun — publish
 * under a vendor namespace that is equally not ours to choose. No versions here.
 * The version always comes from the app.
 *
 * Adding a language is one line, and an app that needs one we have never heard of
 * sets `image` and does not wait for us.
 */
const OFFICIAL: Record<string, string> = {
  python: "python",
  node: "node",
  go: "golang",
  golang: "golang",
  ruby: "ruby",
  php: "php",
  rust: "rust",
  java: "eclipse-temurin",
  elixir: "elixir",
  deno: "denoland/deno",
  bun: "oven/bun",
  dotnet: "mcr.microsoft.com/dotnet/sdk",
  perl: "perl",
  haskell: "haskell",
};

/**
 * Entries that are NOT on Docker Hub, so no Hub mirror can serve them.
 *
 * The reason the mirror is a per-entry rewrite rather than a prefix swap. One
 * line today, and the check is what stops a future entry on quay.io or ghcr.io
 * from being silently rewritten into a path that does not exist.
 */
const NOT_ON_DOCKER_HUB = new Set(["dotnet"]);

/**
 * An Artifact Registry repository that pull-through-caches Docker Hub.
 *
 * Every `FROM python:3.12` is otherwise an anonymous Docker Hub pull from a shared
 * GCP NAT range. That is invisible at today's volume and becomes intermittent
 * build failures at launch volume — and they look like broken apps, so healthy
 * deploys reach the repair agent over somebody else's rate limit.
 *
 * Unset by default so a mirror that cannot be pulled cannot take deploys down
 * either, which is the same rule `BUILDKIT_IMAGE` already follows.
 */
export function dockerMirror(env: Record<string, string | undefined> = process.env): string | null {
  const ref = (env.DOCKER_MIRROR ?? "").trim().replace(/\/+$/, "");
  return ref && /^[A-Za-z0-9._:/-]+$/.test(ref) ? ref : null;
}

/**
 * A repository name as the mirror spells it.
 *
 * Docker Hub's official images live under `library/`, which is invisible in
 * `FROM python:3.12` and mandatory in every other client. `denoland/deno` and
 * `oven/bun` already carry a namespace and keep it.
 */
function throughMirror(repo: string, mirror: string): string {
  return `${mirror}/${repo.includes("/") ? repo : `library/${repo}`}`;
}

/**
 * NOT `-slim`, and this is the trade the whole approach turns on.
 *
 * A slim base drops the compiler and the C headers, and then `pip install
 * psycopg2` fails, and `Pillow`, and `lxml`, and `mysqlclient` — a large slice of
 * real Python, and the same story for native gems and node-gyp. Buildpacks handle
 * that invisibly, and replacing them means either shipping build tools or
 * maintaining a per-package list of system dependencies.
 *
 * A per-package list is the hardcode this file exists to avoid, so the full image
 * is what we ship. It costs a few hundred megabytes, which Cloud Run pulls once
 * and caches. Being slower on a cold pull is recoverable; failing to install a
 * dependency is not.
 *
 * Worth stating plainly rather than as continuity: the Node path was
 * `node:22-slim` in the lane this replaces, so making this universal grows a Node
 * image roughly fivefold. `probeApp`'s timeouts were tuned against a warm shared
 * base and want re-checking against a first pull of that.
 */
export function baseImage(
  i: Partial<DockerfileInput> & { language: string },
  mirror: string | null = dockerMirror(),
): string {
  if (i.image) return i.image;
  const language = i.language.toLowerCase();
  const official = OFFICIAL[language];
  const repo = official && mirror && !NOT_ON_DOCKER_HUB.has(language)
    ? throughMirror(official, mirror)
    : official;
  if (!repo) {
    throw new DockerfileError(
      `no official image is known for "${i.language}".\n` +
      `  Set "build": { "image": "…" } in supersonic.json with any image you like, ` +
      `or commit a Dockerfile — either way the platform gets out of the way.`,
    );
  }
  // The last gate before a string becomes a `FROM`. Callers are supposed to have
  // resolved a range already — `resolveRuntime` does, and records what it chose —
  // but this file had one caller that passed the repo's spec through untouched,
  // which is how `requires-python = ">=3.11,<3.13"` becomes
  // `FROM python:>=3.11,<3.13`. Invisible while the generated Dockerfile was a
  // rare path; a build failure for the majority of range-declaring repos the
  // moment it is the only one.
  if (i.version) assertValidTag(i.version, `the version for ${i.language}`);
  return i.version ? `${repo}:${i.version}` : repo;
}

export class DockerfileError extends Error {}

/**
 * Never copied into the image.
 *
 * `COPY . .` is the obvious line and it copies the local `.env`, the entire `.git`
 * history and any credential lying in the tree into a layer that then sits in a
 * registry. Buildpacks handle this; writing the Dockerfile means owning it, and
 * owning it means a default that is safe rather than a note in a doc.
 */
const DEFAULT_IGNORE = [
  ".git", ".env", ".env.*", "*.pem", "*.key",
  "node_modules", "__pycache__", "*.pyc", ".venv", "venv",
  ".DS_Store", "Dockerfile", ".dockerignore",
];

export function dockerignore(extra: string[] = []): string {
  return [...DEFAULT_IGNORE, ...extra].join("\n") + "\n";
}

/**
 * The manifests worth copying before the source.
 *
 * Layer caching, and the reason it matters: `COPY . .` before `RUN install` means
 * every one-character code change reinstalls every dependency, so a redeploy that
 * should take seconds takes minutes.
 *
 * THIS USED TO BE A GLOB, AND THE GLOB HAD TWO BUGS.
 *
 * It was one instruction — `COPY package.json* … mix.lock* ./` — with a comment
 * claiming "a repo that has none simply skips the step". That is not how `COPY`
 * behaves: **zero matches is a hard build failure**. A Maven, Gradle, .NET or
 * bare-`index.php` app matched none of the twenty names and died on line 6 of
 * every generated Dockerfile. And every glob was root-relative, so a monorepo's
 * `backend/requirements.txt` and `frontend/package.json` were never copied at all,
 * and `RUN (cd frontend && npm ci)` ran against a WORKDIR holding root manifests.
 *
 * So the list is resolved against the disk by `manifestPaths` and emitted
 * path-preserving, one instruction per destination directory. A file that is not
 * there is not named, so there is nothing to fail on.
 */
const MANIFEST_NAMES = [
  // node
  "package.json", "package-lock.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
  "yarn.lock", ".yarnrc.yml", "bun.lock", "bun.lockb", ".npmrc",
  // python
  "requirements.txt", "requirements-prod.txt", "constraints.txt",
  "pyproject.toml", "poetry.lock", "uv.lock", "Pipfile", "Pipfile.lock",
  "setup.py", "setup.cfg",
  // go, rust, ruby, php
  "go.mod", "go.sum", "Cargo.toml", "Cargo.lock",
  "Gemfile", "Gemfile.lock", "composer.json", "composer.lock",
  // java — absent from the old list, which is why Part 8's "now covers Go, Ruby,
  // Java and PHP" was false for Java out of the box.
  "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
  "gradle.properties", "gradlew", "gradlew.bat",
  // elixir
  "mix.exs", "mix.lock",
];

/** Manifests that are found by shape rather than by name. .NET is the whole reason. */
const MANIFEST_PATTERNS = [/\.(csproj|fsproj|vbproj|sln)$/i];

/** Directories whose contents are part of a manifest set rather than of the source. */
const MANIFEST_DIRS = ["gradle/wrapper", ".yarn/releases"];

/**
 * Every dependency manifest that actually exists, repo-relative.
 *
 * The fs read lives here rather than in `generateDockerfile` so the generator
 * stays a pure function of its input — which is what lets a test assert the whole
 * emitted file without a temp directory per case.
 */
export function manifestPaths(contextDir: string, dirs: string[] = ["."]): string[] {
  const found = new Set<string>();
  const rel = (dir: string, name: string) => (dir === "." || dir === "" ? name : `${dir}/${name}`);

  for (const dir of [...new Set(dirs)]) {
    const abs = dir === "." || dir === "" ? contextDir : join(contextDir, dir);
    for (const name of MANIFEST_NAMES) {
      if (existsSync(join(abs, name))) found.add(rel(dir, name));
    }
    try {
      for (const e of readdirSync(abs, { withFileTypes: true })) {
        if (e.isFile() && MANIFEST_PATTERNS.some((p) => p.test(e.name))) found.add(rel(dir, e.name));
      }
    } catch { /* unreadable directory contributes nothing */ }
    for (const sub of MANIFEST_DIRS) {
      if (existsSync(join(abs, sub))) found.add(`${rel(dir, sub)}/`);
    }
  }
  return [...found].sort();
}

/** The directory part of a repo-relative path, or "." for a root file. */
function dirOf(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const i = trimmed.lastIndexOf("/");
  return i === -1 ? "." : trimmed.slice(0, i);
}

/**
 * `COPY` instructions that preserve the paths they came from.
 *
 * One instruction per destination directory, because `COPY a/b.txt ./` puts
 * `b.txt` at the root — Docker flattens multiple sources into one destination.
 * `backend/requirements.txt` has to arrive at `backend/requirements.txt` or the
 * install that runs in `backend/` finds nothing.
 */
function manifestCopies(manifests: string[]): string[] {
  const byDir = new Map<string, string[]>();
  for (const m of manifests) {
    const d = dirOf(m);
    byDir.set(d, [...(byDir.get(d) ?? []), m]);
  }
  return [...byDir.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, files]) => `COPY ${files.join(" ")} ${dir === "." ? "./" : `${dir}/`}`);
}

/** Run a command inside a subdirectory, in a subshell, exactly as `inDir` does. */
function inDir(cmd: string, dir: string): string {
  return dir === "." || dir === "" ? cmd : `(cd ${dir} && ${cmd})`;
}

/** An env var name. Anything else is being injected into a shell line. */
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A `RUN` that can see the build's secrets, without any of them entering a layer.
 *
 * `required=true` on purpose. BuildKit's default is an optional mount, which
 * silently supplies an EMPTY file when the caller forgot to pass the secret — and
 * an empty `DATABASE_URL` is precisely the failure this mechanism exists to
 * prevent, arriving as an inscrutable error from inside the customer's own
 * tooling. Required turns a wiring mistake into a build error that names the id.
 *
 * The value is read into a shell variable rather than mounted as an env var
 * (`env=` on the mount) because that form needs BuildKit ≥0.12, and this project
 * has captured Cloud Build runs on buildx 0.8.2. `export` inside a `RUN` does not
 * persist into the image, so nothing is left behind.
 *
 * Docker performs no variable substitution in `RUN`'s shell form — the shell does
 * — so `$(cat …)` reaches /bin/sh untouched.
 */
function runWithSecrets(cmd: string, secrets: string[]): string {
  if (!secrets.length) return `RUN ${cmd}`;
  const mounts = secrets.map((k) => `--mount=type=secret,id=${k},required=true`).join(" ");
  const exports = secrets.map((k) => `${k}="$(cat /run/secrets/${k})"`).join(" ");
  return `RUN ${mounts} export ${exports} && ${cmd}`;
}

/** The flat input read as one root toolchain, so one code path serves both callers. */
function toolchainsOf(i: DockerfileInput): DockerfileToolchain[] {
  if (i.toolchains?.length) return i.toolchains;
  return [{ language: i.language, version: i.version, install: i.install, build: i.build, dir: "." }];
}

/**
 * Add Node to an image that is not a Node image.
 *
 * Used only when a second toolchain shares the FIRST one's directory — a Python
 * API whose assets are built by a `package.json` in the same folder, which is an
 * ordinary shape and not one a build stage can serve, because the stage would have
 * to copy its output back over the directory the primary just installed into.
 *
 * Copying `/usr/local/bin/node` and `/usr/local/lib/node_modules` is the standard
 * recipe and it works because every official language image here is Debian- or
 * Ubuntu-based, so the binary is compatible. It is deliberately the only graft
 * offered: the reverse — grafting Python into a Node image — would mean copying a
 * whole `/usr/local` over one that is already occupied.
 */
function graftNode(version: string | undefined): string[] {
  const from = baseImage({ language: "node", version });
  return [
    `# A second toolchain in the same directory as the first, so it is added here`,
    `# rather than built in its own stage — a stage would have to copy its output`,
    `# back over the directory the primary already installed into.`,
    `COPY --from=${from} /usr/local/bin/node /usr/local/bin/node`,
    `COPY --from=${from} /usr/local/lib/node_modules /usr/local/lib/node_modules`,
    `RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm ` +
    `&& ln -sf ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack`,
  ];
}

/** `PATH` entries for the interpreters an install puts somewhere Docker will not find. */
function pathEntries(toolchains: DockerfileToolchain[]): string[] {
  const out: string[] = [];
  for (const t of toolchains) {
    const root = t.dir === "." || t.dir === "" ? "/app" : `/app/${t.dir}`;
    if (t.language === "python") out.push(`${root}/.venv/bin`);
    if (t.language === "node") out.push(`${root}/node_modules/.bin`);
  }
  return [...new Set(out)];
}

function aptLayer(needs: string[]): string[] {
  if (!needs.length) return [];
  return [
    `RUN apt-get update && apt-get install -y --no-install-recommends ${[...new Set(needs)].sort().join(" ")} ` +
    `&& rm -rf /var/lib/apt/lists/*`,
    ``,
  ];
}

/**
 * The Dockerfile for one app.
 *
 * Deliberately boring. Everything specific — the version, the install command, the
 * build command, what to run — is resolved somewhere else and arrives as an
 * argument. Nothing here knows a framework, and the only judgement it makes is
 * layer ordering.
 *
 * Written into OUR copy of the repo, never the author's. Editing a customer's tree
 * is what `stripQualityGates` did, and it is not something a build path should do.
 */
export function generateDockerfile(i: DockerfileInput): string {
  const command = i.command.trim();
  if (!command) throw new DockerfileError("a generated Dockerfile needs a command to run");

  const chains = toolchainsOf(i);
  const primary = chains[0];
  if (!primary) throw new DockerfileError("a generated Dockerfile needs a language to build on");

  // Every other toolchain that lives somewhere else builds in its own stage, on
  // its own base image, and hands its directory back. That is what a person would
  // write for a Python API beside a JavaScript frontend, and it needs no binary
  // grafting: each half installs with the tools its own image already carries.
  const staged = chains.slice(1).filter((t) => t.dir !== primary.dir);
  const grafted = chains.slice(1).filter((t) => t.dir === primary.dir);

  const secrets = [...new Set(i.buildSecrets ?? [])];
  const args = [...new Set(i.buildArgs ?? [])];
  for (const k of [...secrets, ...args]) {
    if (!SAFE_KEY.test(k)) {
      throw new DockerfileError(`build variable "${k}" is not a usable name — letters, digits and underscore only`);
    }
  }

  const lines: string[] = [
    // Only when a secret is mounted, and only then: this line makes Docker fetch
    // the Dockerfile frontend from Docker Hub, which is a dependency the rest of
    // this file works hard not to have. `RUN --mount` needs it on older frontends
    // and nothing else here does, so it is paid for exactly when it buys
    // something. The base-image mirror should cover it.
    ...(secrets.length ? [`# syntax=docker/dockerfile:1`] : []),
    `# Generated by Supersonic. Your repo is unchanged — this lives in the build copy.`,
    `# The version comes from your own file; nothing here is the platform's choice.`,
  ];

  // `ARG` does not cross a stage boundary, so every stage that runs a build
  // declares them again.
  const argLines = args.flatMap((k) => [`ARG ${k}`, `ENV ${k}=\${${k}}`]);

  const stageName = (t: DockerfileToolchain, n: number) => `deps${n}_${t.language}`.replace(/[^A-Za-z0-9_]/g, "_");

  staged.forEach((t, n) => {
    lines.push(
      ``,
      `FROM ${baseImage({ language: t.language, version: t.version, image: i.image && chains.length === 1 ? i.image : undefined })} AS ${stageName(t, n)}`,
      `WORKDIR /app`,
      ...huskyEnv([t]),
      ...argLines,
      ...manifestCopies((i.manifests ?? []).filter((m) => m === t.dir || dirOf(m) === t.dir)),
    );
    if (t.install?.trim()) lines.push(runWithSecrets(inDir(t.install.trim(), t.dir), secrets));
    lines.push(`COPY . .`);
    if (t.installProject?.trim()) lines.push(runWithSecrets(inDir(t.installProject.trim(), t.dir), secrets));
    if (t.build?.trim()) lines.push(runWithSecrets(inDir(t.build.trim(), t.dir), secrets));
  });

  lines.push(
    ``,
    ...(primary.versionFrom ? [`# ${primary.language} ${primary.version ?? ""} — ${primary.versionFrom}`] : []),
    `FROM ${baseImage({ language: primary.language, version: primary.version, image: i.image })}`,
    ``,
    `WORKDIR /app`,
  );

  for (const t of grafted) {
    if (t.language === "node" && primary.language !== "node") lines.push(...graftNode(t.version));
    else if (t.language !== primary.language) {
      // Said out loud in the file the user can read, rather than dropped. An
      // accepted-and-ignored toolchain is the same defect as an accepted-and-
      // ignored config field, and this is the surface where it is visible.
      lines.push(`# NOTE: this directory also declares ${t.language}, which cannot be added to a`);
      lines.push(`# ${primary.language} image automatically. Commit a Dockerfile to build both.`);
    }
  }

  lines.push(...huskyEnv(chains), ...argLines, ...aptLayer(i.needs ?? []));

  // Layer caching: manifests first, so an unchanged dependency set is reused. When
  // none resolved — a repo with no manifest we know, or a caller that did not look
  // — the source is copied first instead. That costs the cache and builds; naming
  // a file that is not there costs the whole build.
  const primaryManifests = (i.manifests ?? []).filter((m) => !staged.some((t) => dirOf(m) === t.dir));
  const cacheable = chains.filter((t) => !staged.includes(t));
  const copies = manifestCopies(primaryManifests);

  const run = (cmd: string, dir: string) => runWithSecrets(inDir(cmd.trim(), dir), secrets);

  if (copies.length) {
    lines.push(...copies);
    for (const t of cacheable) if (t.install?.trim()) lines.push(run(t.install, t.dir));
    lines.push(``, `COPY . .`);
  } else {
    lines.push(`COPY . .`);
    for (const t of cacheable) if (t.install?.trim()) lines.push(run(t.install, t.dir));
  }

  // `uv sync` and `pip install .` build the LOCAL project, so they cannot run in
  // the cached layer above — there is no source there yet.
  for (const t of cacheable) if (t.installProject?.trim()) lines.push(run(t.installProject, t.dir));
  for (const t of cacheable) if (t.build?.trim()) lines.push(run(t.build, t.dir));

  // Each build stage hands back the directory it owns.
  staged.forEach((t, n) => lines.push(`COPY --from=${stageName(t, n)} /app/${t.dir} ./${t.dir}`));

  const path = pathEntries(chains);
  lines.push(
    ``,
    // Cloud Run assigns the port and injects it; the app must read it. Stated so
    // an image run anywhere else has a sane default rather than nothing.
    `ENV PORT=8080`,
    // Unbuffered by default: without it a crashing Python process loses the
    // traceback that says why, which is the single most expensive log line in the
    // product to be missing.
    `ENV PYTHONUNBUFFERED=1`,
    // An install puts executables where only its own tooling looks. Without this a
    // command naming one of them exits 127, and the user is told the app did not
    // listen on $PORT.
    ...(path.length ? [`ENV PATH=${path.join(":")}:$PATH`] : []),
    // `sh -c` because a start command is a shell line — pipes, `&&`, `$PORT` —
    // and exec form would treat all of it as one program name.
    `CMD ["/bin/sh", "-c", ${JSON.stringify((i.waitFor ?? "") + command)}]`,
    ``,
  );
  return lines.join("\n");
}

/**
 * `HUSKY=0`, when anything here installs with npm.
 *
 * `.dockerignore` removes `.git`, which is exactly when the near-universal
 * `"prepare": "husky"` hook exits 127 and takes `npm ci` down with it. The repo is
 * fine, the install command is right, and the build fails on a line about a
 * directory we deliberately did not copy.
 */
function huskyEnv(toolchains: DockerfileToolchain[]): string[] {
  return toolchains.some((t) => t.language === "node") ? [`ENV HUSKY=0`] : [];
}
