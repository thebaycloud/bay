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
 * Dockerfiles. The difference is what they encoded: they named **Vite**, **Create
 * React App** and **Next.js** — products, with per-framework build layouts and
 * output directories, which is a matrix that grows forever and is wrong the moment
 * a framework changes.
 *
 * This names a language and takes its version from the app's own file. The base
 * image is a registry lookup — Docker Hub's official image for a language is that
 * language's name in nearly every case — and it is a DEFAULT the app can override.
 * There is no framework here, no build layout, and no version of our own.
 */

/** How the app's dependencies and start command are already resolved elsewhere. */
export interface DockerfileInput {
  /** "python" | "node" | "go" | … — whatever the repo declares. Never enumerated by us. */
  language: string;
  /** Exactly what the repo's own file said. "3.12", "22", "1.83". */
  version?: string;
  /** The base image, when the app would rather choose. Skips everything below. */
  image?: string;
  install?: string;
  build?: string;
  /** The command the container runs. From `start` or the web process. */
  command: string;
  /** Files never copied into the image. See DEFAULT_IGNORE. */
  ignore?: string[];
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
 */
export function baseImage(i: DockerfileInput): string {
  if (i.image) return i.image;
  const repo = OFFICIAL[i.language.toLowerCase()];
  if (!repo) {
    throw new DockerfileError(
      `no official image is known for "${i.language}".\n` +
      `  Set "build": { "image": "…" } in supersonic.json with any image you like, ` +
      `or commit a Dockerfile — either way the platform gets out of the way.`,
    );
  }
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
 * should take seconds takes minutes. Copying the dependency manifests first lets
 * Docker reuse the install layer whenever they have not changed.
 *
 * Deliberately a glob of the FILES ecosystems use to pin dependencies, not a map
 * from language to filename: a repo that has none simply skips the step and pays
 * for a full install, which is exactly what it would have paid anyway.
 */
const MANIFESTS = [
  "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
  "requirements.txt", "pyproject.toml", "poetry.lock", "uv.lock", "Pipfile", "Pipfile.lock",
  "go.mod", "go.sum", "Gemfile", "Gemfile.lock", "composer.json", "composer.lock",
  "Cargo.toml", "Cargo.lock", "mix.exs", "mix.lock",
];

/**
 * The Dockerfile for one app.
 *
 * Deliberately short and deliberately boring. Everything specific — the version,
 * the install command, the build command, what to run — is already resolved
 * somewhere else and arrives as an argument. Nothing here knows a framework, and
 * the only judgement it makes is layer ordering.
 *
 * Written into OUR copy of the repo, never the author's. Editing a customer's tree
 * is what `stripQualityGates` did, and it is not something a build path should do.
 */
export function generateDockerfile(i: DockerfileInput): string {
  const command = i.command.trim();
  if (!command) throw new DockerfileError("a generated Dockerfile needs a command to run");

  const lines = [
    `# Generated by Supersonic. Your repo is unchanged — this lives in the build copy.`,
    `# The version comes from your own file; nothing here is the platform's choice.`,
    `FROM ${baseImage(i)}`,
    ``,
    `WORKDIR /app`,
    // Layer caching: manifests first, so an unchanged dependency set is reused.
    // `COPY x* ./` tolerates a file that is not there, which `COPY x ./` does not
    // — and a repo missing any one of these is the normal case, not an error.
    `COPY ${MANIFESTS.map((m) => `${m}*`).join(" ")} ./`,
  ];

  if (i.install?.trim()) lines.push(`RUN ${i.install.trim()}`);
  lines.push(``, `COPY . .`);
  if (i.build?.trim()) lines.push(`RUN ${i.build.trim()}`);

  lines.push(
    ``,
    // Cloud Run assigns the port and injects it; the app must read it. Stated so
    // an image run anywhere else has a sane default rather than nothing.
    `ENV PORT=8080`,
    // Unbuffered by default: without it a crashing Python process loses the
    // traceback that says why, which is the single most expensive log line in the
    // product to be missing.
    `ENV PYTHONUNBUFFERED=1`,
    // `sh -c` because a start command is a shell line — pipes, `&&`, `$PORT` —
    // and exec form would treat all of it as one program name.
    `CMD ["/bin/sh", "-c", ${JSON.stringify(command)}]`,
    ``,
  );
  return lines.join("\n");
}
