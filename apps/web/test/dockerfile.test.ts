import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateDockerfile, baseImage, dockerMirror, dockerignore, manifestPaths, DockerfileError } from "../lib/dockerfile";
import { proxyWait } from "../lib/release-job";

const base = { language: "python", command: "gunicorn app:app --bind 0.0.0.0:$PORT" };

test("any language, at any version, without anyone preparing a runtime", () => {
  // Both limits the platform had, gone for the same reason. The runner has two
  // images because someone built two Dockerfiles; Google's builder has no Rust,
  // Elixir, Deno or Bun, and its Python is 3.13 and 3.14 only — which is how an
  // app pinning 3.12 failed AFTER being routed correctly. Docker Hub already has
  // all of them.
  const at = (language: string, version?: string) => baseImage({ language, version, command: "x" });

  assert.equal(at("python", "3.12"), "python:3.12");   // the version buildpacks refused
  assert.equal(at("node", "20"), "node:20");
  assert.equal(at("rust", "1.83"), "rust:1.83");       // no buildpack at all
  assert.equal(at("elixir", "1.17"), "elixir:1.17");
  assert.equal(at("deno", "2.1"), "denoland/deno:2.1");
  assert.equal(at("bun", "1"), "oven/bun:1");
  assert.equal(at("go", "1.23"), "golang:1.23");
  assert.equal(at("ruby", "3.3"), "ruby:3.3");
});

test("the base image can come through a mirror, per entry and not by prefix", () => {
  // Every `FROM python:3.12` is otherwise an anonymous Docker Hub pull from a
  // shared GCP NAT range: invisible now, intermittent build failures at launch
  // volume — and they look like broken apps, so healthy deploys reach the repair
  // agent over somebody else's rate limit.
  const M = "us-central1-docker.pkg.dev/supersonic-deploy-prod/docker-hub";
  const at = (language: string, version?: string) => baseImage({ language, version }, M);

  // Official images live under `library/`, which is invisible in `FROM python`
  // and mandatory in every other client.
  assert.equal(at("python", "3.12"), `${M}/library/python:3.12`);
  assert.equal(at("go", "1.23"), `${M}/library/golang:1.23`);
  // A repo that already carries a namespace keeps it.
  assert.equal(at("deno", "2.1"), `${M}/denoland/deno:2.1`);
  assert.equal(at("bun", "1"), `${M}/oven/bun:1`);
  // …and one that is NOT on Docker Hub is left alone, which is why this is a
  // per-entry rewrite rather than a prefix swap.
  assert.equal(at("dotnet", "8.0"), "mcr.microsoft.com/dotnet/sdk:8.0");

  // Unset by default, so a mirror that cannot be pulled cannot take deploys down.
  assert.equal(baseImage({ language: "python", version: "3.12" }, null), "python:3.12");
  assert.equal(dockerMirror({}), null);
  assert.equal(dockerMirror({ DOCKER_MIRROR: `${M}/` }), M, "a trailing slash must not double up");
  assert.equal(dockerMirror({ DOCKER_MIRROR: "not a ref; rm -rf /" }), null);
});

test("an app can name its own image, so an unknown language is never a wait", () => {
  // The escape hatch that keeps the table above from being a gate. A language we
  // have never heard of is one line of config away, not a release away.
  assert.equal(baseImage({ language: "zig", image: "ziglang/zig:0.13", command: "x" }), "ziglang/zig:0.13");
  assert.equal(baseImage({ language: "python", version: "3.12", image: "python:3.12-alpine", command: "x" }), "python:3.12-alpine");

  // And without one, the refusal names the two ways out rather than just saying no.
  assert.throws(() => baseImage({ language: "zig", command: "x" }), (e: Error) => {
    assert.ok(e instanceof DockerfileError);
    assert.match(e.message, /"build": \{ "image"/);
    assert.match(e.message, /commit a Dockerfile/);
    return true;
  });
});

test("a range never becomes a FROM, whoever hands one over", () => {
  // deploy-pipeline.ts:1602 passes the repo's spec through untouched, so
  // `requires-python = ">=3.11,<3.13"` reaches here as the version and emits
  // `FROM python:>=3.11,<3.13` — a reference Docker cannot parse. It is invisible
  // while the generated Dockerfile is a rare path and a build failure for the
  // majority of range-declaring repos the moment it is the only one.
  //
  // `resolveRuntime` is what turns a range into a tag. This is the gate that makes
  // forgetting to call it a caught error rather than an `invalid reference format`
  // forty lines into a build log with no filename in it.
  for (const bad of [">=3.11,<3.13", "^20", "~> 3.3", "lts/*", "3.12 <-- edit me", "-3.12"]) {
    assert.throws(() => baseImage({ language: "python", version: bad, command: "x" }), /not a version/);
  }
  assert.equal(baseImage({ language: "python", version: "3.12-slim", command: "x" }), "python:3.12-slim");
});

test("dependencies install before the source is copied", () => {
  // Layer caching, and why it matters: `COPY . .` before the install means every
  // one-character code change reinstalls everything, so a redeploy that should
  // take seconds takes minutes.
  const df = generateDockerfile({
    ...base, install: "pip install -r requirements.txt", manifests: ["requirements.txt"],
  });

  const manifests = df.indexOf("COPY requirements.txt ./");
  const install = df.indexOf("RUN pip install");
  const source = df.indexOf("COPY . .");

  assert.ok(manifests !== -1, "the manifest must be copied by name");
  assert.ok(manifests < install, "manifests must be copied before the install");
  assert.ok(install < source, "the install layer must precede the source, or it is never reused");
});

test("only manifests that exist are named, because COPY does not skip a miss", () => {
  // The belief this replaces, written down at the old MANIFESTS: "a repo that has
  // none simply skips the step". `COPY x* ./` with ZERO matches is a hard build
  // failure, not a skip — so a Maven, Gradle, .NET or bare-index.php app died on
  // line 6 of every generated Dockerfile, because none of the twenty globbed names
  // existed in it.
  const df = generateDockerfile({ ...base, install: "pip install -r requirements.txt", manifests: ["requirements.txt"] });
  const copies = df.split("\n").filter((l) => l.startsWith("COPY ") && l !== "COPY . .");

  assert.deepEqual(copies, ["COPY requirements.txt ./"]);
  assert.doesNotMatch(df, /\*/, "a glob can match nothing, and nothing is a failed build");
  for (const absent of ["Gemfile", "go.mod", "Cargo.toml", "mix.exs", "package.json"]) {
    assert.ok(!df.includes(absent), `${absent} is not in this repo and must not be named`);
  }
});

test("with no manifest resolved, the source is copied first rather than nothing", () => {
  // A repo whose dependency file we do not know, or a caller that did not look.
  // Emitting a COPY for a file that is not there fails the build; copying the
  // source first costs the layer cache and works. That is the right way round.
  const df = generateDockerfile({ ...base, install: "pip install -r requirements.txt" });

  assert.ok(df.indexOf("COPY . .") < df.indexOf("RUN pip install"));
  assert.equal(df.split("\n").filter((l) => l.startsWith("COPY ")).length, 1);
});

test("a monorepo's manifests arrive where the install will look for them", () => {
  // `COPY a/b.txt ./` puts b.txt at the ROOT — Docker flattens several sources
  // into one destination. Every glob in the old list was root-relative too, so
  // `RUN (cd frontend && npm ci)` ran against a WORKDIR holding root manifests and
  // installed nothing. build-config.ts already recorded the same failure for the
  // runner: "a monorepo matches none of its cases."
  const df = generateDockerfile({
    language: "python",
    command: "gunicorn app:app -b :$PORT",
    manifests: ["backend/requirements.txt", "frontend/package.json", "frontend/package-lock.json", "package.json"],
    toolchains: [
      { language: "python", version: "3.12", install: "pip install -r requirements.txt", dir: "backend" },
    ],
  });

  // One instruction per destination directory, each preserving its path.
  assert.match(df, /^COPY backend\/requirements\.txt backend\/$/m);
  assert.match(df, /^COPY frontend\/package\.json frontend\/package-lock\.json frontend\/$/m);
  assert.match(df, /^COPY package\.json \.\/$/m);
  assert.match(df, /RUN \(cd backend && pip install -r requirements\.txt\)/);
});

test("secrets and history never enter the image", () => {
  // `COPY . .` is the obvious line and it copies the local .env, the whole .git
  // history and any key lying in the tree into a layer that then sits in a
  // registry. Buildpacks handled this; writing the Dockerfile means owning it.
  const ignore = dockerignore().split("\n");

  for (const secret of [".env", ".env.*", "*.pem", "*.key", ".git"]) {
    assert.ok(ignore.includes(secret), `${secret} would be baked into the image`);
  }
  assert.ok(ignore.includes("node_modules"), "a local node_modules would shadow the installed one");
  assert.ok(dockerignore(["uploads/"]).includes("uploads/"));
});

test("the command runs through a shell, because a start command is a shell line", () => {
  const df = generateDockerfile({ ...base, command: "python migrate.py && gunicorn app:app --bind 0.0.0.0:$PORT" });

  // Exec form would treat the whole string as one program name and fail on a repo
  // whose start command has a `&&` in it — which is most Django apps.
  assert.match(df, /CMD \["\/bin\/sh", "-c", ".*&&.*"\]/);
  assert.match(df, /ENV PORT=8080/);
  // A crashing Python process without this loses the traceback that says why.
  assert.match(df, /ENV PYTHONUNBUFFERED=1/);
});

test("a build step runs after the source, an install before it", () => {
  const df = generateDockerfile({
    ...base, install: "npm ci", build: "npm run build", language: "node", manifests: ["package.json", "package-lock.json"],
  });

  assert.ok(df.indexOf("RUN npm ci") < df.indexOf("COPY . ."), "install is a cacheable layer");
  assert.ok(df.indexOf("COPY . .") < df.indexOf("RUN npm run build"), "a build needs the source");
});

test("no framework appears anywhere in a generated Dockerfile", () => {
  // The difference from `spaDockerfile` and `nextDockerfile`, which this replaces.
  // Those named Vite, Create React App and Next.js — products, with per-framework
  // build layouts and output directories, a matrix that grows forever and is wrong
  // the moment a framework changes. This names a language and a version the app
  // chose.
  const df = generateDockerfile({ ...base, install: "pip install -r requirements.txt", build: "python -m compileall ." });

  for (const noun of ["next", "vite", "react", "django", "flask", "rails", "express", "nuxt"]) {
    assert.doesNotMatch(df.toLowerCase(), new RegExp(`\\b${noun}\\b`), `"${noun}" is a product name and does not belong here`);
  }
});

test("it says the repo is untouched, because that is the promise being made", () => {
  // Written into OUR copy, never the author's tree. Editing a customer's repo is
  // what stripQualityGates did to their package.json, and it is not something a
  // build path should ever do.
  assert.match(generateDockerfile(base), /Your repo is unchanged/);
});

/* -------------------------------------------------------------------------- */
/* Two toolchains in one image                                                */
/* -------------------------------------------------------------------------- */

test("a repo with two languages in two directories builds both", () => {
  // Required, or every Python-API-beside-a-JavaScript-frontend repository breaks.
  // The second toolchain gets its own stage on its own base image and hands its
  // directory back — which is what a person would write, and needs no grafting:
  // each half installs with the tools its own image already carries.
  const df = generateDockerfile({
    language: "python",
    command: "gunicorn api.wsgi:application -b :$PORT",
    manifests: ["backend/requirements.txt", "frontend/package.json"],
    toolchains: [
      { language: "python", version: "3.12", install: "pip install -r requirements.txt", dir: "backend" },
      { language: "node", version: "22", install: "npm ci", build: "npm run build", dir: "frontend" },
    ],
  });

  const stage = df.match(/^FROM node:22 AS (\S+)$/m);
  assert.ok(stage, "the second toolchain needs its own stage");
  assert.match(df, /^FROM python:3\.12$/m);
  assert.match(df, new RegExp(`^COPY --from=${stage![1]} /app/frontend \\./frontend$`, "m"));

  // Each stage installs from its own directory with its own manifests.
  assert.ok(df.indexOf("COPY frontend/package.json frontend/") < df.indexOf("RUN (cd frontend && npm ci)"));
  assert.ok(df.indexOf("RUN (cd frontend && npm ci)") < df.indexOf("RUN (cd frontend && npm run build)"));
  // …and the serving image never runs the frontend's install.
  assert.ok(df.indexOf("FROM python:3.12") < df.indexOf("RUN (cd backend && pip install"));
});

test("a second toolchain in the SAME directory is added to the image, not staged", () => {
  // A Python API whose assets are built by a package.json in the same folder is an
  // ordinary shape, and a build stage cannot serve it: the stage would copy its
  // output back over the directory the primary just installed into.
  const df = generateDockerfile({
    language: "python",
    command: "gunicorn app:app -b :$PORT",
    manifests: ["requirements.txt", "package.json"],
    toolchains: [
      { language: "python", version: "3.12", install: "pip install -r requirements.txt", dir: "." },
      { language: "node", version: "22", install: "npm ci", build: "npm run build", dir: "." },
    ],
  });

  assert.doesNotMatch(df, / AS /, "same-directory toolchains cannot be split into stages");
  assert.match(df, /COPY --from=node:22 \/usr\/local\/bin\/node \/usr\/local\/bin\/node/);
  assert.match(df, /ln -sf \.\.\/lib\/node_modules\/npm\/bin\/npm-cli\.js/);
  // Both installs run, in the one image.
  assert.match(df, /RUN pip install -r requirements\.txt/);
  assert.match(df, /RUN npm ci/);
});

test("a same-directory toolchain we cannot add says so in the file", () => {
  // An accepted-and-ignored toolchain is the same defect as an accepted-and-
  // ignored config field. The generated Dockerfile is the surface where it is
  // visible, so it is said there rather than dropped.
  const df = generateDockerfile({
    language: "python",
    command: "gunicorn app:app -b :$PORT",
    toolchains: [
      { language: "python", version: "3.12", dir: "." },
      { language: "ruby", version: "3.4", install: "bundle install", dir: "." },
    ],
  });
  assert.match(df, /NOTE: this directory also declares ruby/);
  assert.match(df, /Commit a Dockerfile to build both/);
});

/* -------------------------------------------------------------------------- */
/* The four things the runner did that a plain image does not                  */
/* -------------------------------------------------------------------------- */

test("the interpreters an install writes are on PATH", () => {
  // An install puts executables where only its own tooling looks. Without this a
  // command naming one of them exits 127 — and the user is told the app did not
  // listen on $PORT, which sends them looking for a port bug that does not exist.
  const df = generateDockerfile({
    language: "python",
    command: "gunicorn app:app -b :$PORT",
    toolchains: [
      { language: "python", version: "3.12", dir: "backend" },
      { language: "node", version: "22", dir: "frontend" },
    ],
  });
  assert.match(df, /ENV PATH=\/app\/backend\/\.venv\/bin:\/app\/frontend\/node_modules\/\.bin:\$PATH/);

  // Nothing to add for a language that installs into the image itself.
  assert.doesNotMatch(generateDockerfile({ language: "go", version: "1.23", command: "/app/server" }), /ENV PATH=/);
});

test("HUSKY=0, because .dockerignore removes the .git the hook needs", () => {
  // The near-universal `"prepare": "husky"` exits 127 without a .git directory,
  // and takes `npm ci` down with it. The repo is fine and the install command is
  // right; the build fails on a line about a directory we deliberately did not
  // copy.
  assert.match(generateDockerfile({ language: "node", version: "22", command: "node i.js" }), /ENV HUSKY=0/);
  assert.doesNotMatch(generateDockerfile({ language: "go", version: "1.23", command: "/app/server" }), /HUSKY/);
});

test("apt packages install in one layer, before the dependencies that need them", () => {
  const df = generateDockerfile({
    language: "python",
    command: "gunicorn app:app -b :$PORT",
    install: "pip install -r requirements.txt",
    manifests: ["requirements.txt"],
    needs: ["default-libmysqlclient-dev", "pkg-config"],
  });
  assert.match(df, /RUN apt-get update && apt-get install -y --no-install-recommends default-libmysqlclient-dev pkg-config && rm -rf \/var\/lib\/apt\/lists\/\*/);
  assert.ok(df.indexOf("apt-get install") < df.indexOf("RUN pip install"));
  assert.doesNotMatch(generateDockerfile({ language: "go", version: "1.23", command: "/app/server" }), /apt-get/);
});

test("the database wait is part of the command, not a second entrypoint", () => {
  // `--depends-on` orders container START, not port readiness. An app that
  // connects at import time can lose the race against the proxy binding and die on
  // "connection refused" — a failure indistinguishable from a database that does
  // not exist.
  const df = generateDockerfile({
    language: "python", version: "3.12",
    command: "gunicorn app:app -b :$PORT",
    waitFor: proxyWait("127.0.0.1", "5432", 30),
  });
  const cmd = df.match(/^CMD \["\/bin\/sh", "-c", (".*")\]$/m)![1];
  const script = JSON.parse(cmd) as string;
  assert.ok(script.startsWith("if command -v nc"), "the wait comes first or it is not a wait");
  assert.ok(script.endsWith("gunicorn app:app -b :$PORT"));
});

/* -------------------------------------------------------------------------- */
/* manifestPaths — the fs half                                                */
/* -------------------------------------------------------------------------- */

test("manifestPaths names only what is on disk, per directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "manifests-"));
  for (const rel of [
    "package.json", "backend/requirements.txt", "backend/pyproject.toml",
    "frontend/package.json", "frontend/pnpm-lock.yaml", "frontend/src/index.ts",
  ]) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), "");
  }

  assert.deepEqual(manifestPaths(dir, [".", "backend", "frontend"]), [
    "backend/pyproject.toml", "backend/requirements.txt",
    "frontend/package.json", "frontend/pnpm-lock.yaml",
    "package.json",
  ]);
  // A directory that was not asked about contributes nothing, and source files
  // are not manifests.
  assert.deepEqual(manifestPaths(dir, ["."]), ["package.json"]);
  assert.deepEqual(manifestPaths(dir, ["nonexistent"]), []);
});

test("manifestPaths covers the four ecosystems the glob list left out", () => {
  // Part 8's "now covers Go, Ruby, Java and PHP" was false for Java out of the
  // box: pom.xml, build.gradle*, *.csproj, bun.lock, pnpm-workspace.yaml and
  // .npmrc were all absent from the old twenty names, so those apps died on the
  // COPY rather than on anything to do with their code.
  const dir = mkdtempSync(join(tmpdir(), "manifests2-"));
  for (const rel of ["pom.xml", "build.gradle.kts", "Api.csproj", "bun.lock", "pnpm-workspace.yaml", ".npmrc", "gradle/wrapper/gradle-wrapper.properties"]) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), "");
  }
  const found = manifestPaths(dir);
  for (const expected of ["pom.xml", "build.gradle.kts", "Api.csproj", "bun.lock", "pnpm-workspace.yaml", ".npmrc", "gradle/wrapper/"]) {
    assert.ok(found.includes(expected), `${expected} is missing from the manifest set`);
  }
});

/* -------------------------------------------------------------------------- */
/* Build-time secrets                                                          */
/* -------------------------------------------------------------------------- */

test("a build secret is mounted, and never becomes a layer", () => {
  // Why this exists at all, from the config being deleted: Prisma 7 evaluates
  // `env('DATABASE_URL')` while loading prisma.config.js on EVERY cli command, so
  // `prisma generate` died on an app whose database the platform had just
  // provisioned. The runner was the only build path that could mount one.
  const df = generateDockerfile({
    language: "node", version: "22",
    command: "node server.js",
    install: "npm ci", build: "npx prisma generate && npm run build",
    manifests: ["package.json"],
    buildSecrets: ["DATABASE_URL"],
  });

  assert.match(df, /RUN --mount=type=secret,id=DATABASE_URL,required=true export DATABASE_URL="\$\(cat \/run\/secrets\/DATABASE_URL\)" && npm ci/);
  assert.match(df, /--mount=type=secret,id=DATABASE_URL,required=true .*prisma generate/);

  // ARG would put the value in image history. It must not appear as one.
  assert.doesNotMatch(df, /ARG DATABASE_URL/);
  assert.doesNotMatch(df, /ENV DATABASE_URL/);
});

test("required=true, because an optional mount supplies an empty file in silence", () => {
  // BuildKit's default is optional: forget to pass the secret and the RUN gets an
  // empty file, so `DATABASE_URL` is "" and the failure arrives from inside the
  // customer's own tooling with nothing pointing at the wiring. Required turns
  // that into a build error naming the id.
  const df = generateDockerfile({
    language: "node", version: "22", command: "node i.js", install: "npm ci", buildSecrets: ["A", "B"],
  });
  assert.equal(df.match(/required=true/g)?.length, 2);
  assert.match(df, /export A="\$\(cat \/run\/secrets\/A\)" B="\$\(cat \/run\/secrets\/B\)"/);
});

test("the syntax directive is paid for only when a mount needs it", () => {
  // `# syntax=docker/dockerfile:1` makes Docker fetch the frontend from Docker
  // Hub — the dependency the rest of this file works to avoid. `RUN --mount`
  // needs it on older frontends and nothing else here does.
  const withSecret = generateDockerfile({ language: "node", version: "22", command: "node i.js", install: "npm ci", buildSecrets: ["X"] });
  assert.ok(withSecret.startsWith("# syntax=docker/dockerfile:1\n"));

  const without = generateDockerfile({ language: "node", version: "22", command: "node i.js", install: "npm ci" });
  assert.doesNotMatch(without, /syntax=docker/);
});

test("a public build value is an ARG, present in every stage that builds", () => {
  // `ARG` does not cross a stage boundary, so a frontend built in its own stage
  // sees nothing unless it is declared there too — and a bundler that runs without
  // it bakes the wrong value into the shipped JavaScript, silently.
  const df = generateDockerfile({
    language: "python",
    command: "gunicorn app:app -b :$PORT",
    buildArgs: ["NEXT_PUBLIC_API_URL"],
    toolchains: [
      { language: "python", version: "3.12", dir: "backend" },
      { language: "node", version: "22", build: "npm run build", dir: "frontend" },
    ],
  });
  assert.equal(df.match(/^ARG NEXT_PUBLIC_API_URL$/gm)?.length, 2, "one per stage");
  assert.equal(df.match(/^ENV NEXT_PUBLIC_API_URL=\$\{NEXT_PUBLIC_API_URL\}$/gm)?.length, 2);
});

test("a build variable name that is not a name is refused", () => {
  for (const key of ["A B", "A;rm -rf /", "$(id)", "1BAD"]) {
    assert.throws(() => generateDockerfile({ language: "node", version: "22", command: "x", buildSecrets: [key] }), DockerfileError);
    assert.throws(() => generateDockerfile({ language: "node", version: "22", command: "x", buildArgs: [key] }), DockerfileError);
  }
});

/* -------------------------------------------------------------------------- */
/* Generated AND built                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `docker build`, when there is a daemon to build with.
 *
 * Skipped rather than dropped, because the bug this file exists to close is
 * invisible to every assertion above it: `COPY x* ./` LOOKS fine, reads fine, and
 * fails at build time when nothing matches. The comment that shipped with it —
 * "a repo that has none simply skips the step" — was written by someone reasoning
 * about the string rather than running it. Only a real build tells them apart.
 *
 * `busybox` rather than a language image on purpose: what is under test is the
 * COPY instructions the generator emits, and a 1 GB pull proves nothing extra
 * about them.
 */
function dockerReady(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const buildable = dockerReady();

function buildsClean(files: Record<string, string>, input: Parameters<typeof generateDockerfile>[0]): void {
  const dir = mkdtempSync(join(tmpdir(), "docker-build-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  writeFileSync(join(dir, "Dockerfile"), generateDockerfile(input));
  writeFileSync(join(dir, ".dockerignore"), dockerignore());
  execFileSync("docker", ["build", "-q", "-t", "supersonic-dockerfile-test", "."], {
    cwd: dir, stdio: "pipe", timeout: 180_000,
  });
}

test("a repo with no manifest we recognise still builds", { skip: !buildable }, () => {
  // The exact shape that died on line 6 of every generated Dockerfile: nothing in
  // the tree matched any of the twenty globbed names, so `COPY … ./` matched zero
  // files and failed the build before a single dependency was considered.
  assert.doesNotThrow(() => buildsClean(
    { "server.sh": "#!/bin/sh\necho up\n" },
    { language: "unused", image: "busybox:latest", command: "sh server.sh", manifests: manifestPaths(mkdtempSync(join(tmpdir(), "empty-"))) },
  ));
});

test("a monorepo's manifests really do land in their own directories", { skip: !buildable }, () => {
  // `COPY a/b.txt ./` puts b.txt at the root. The build below fails if they
  // flatten, because the RUN checks for them where the install would look.
  assert.doesNotThrow(() => buildsClean(
    {
      "package.json": "{}",
      "backend/requirements.txt": "flask\n",
      "frontend/package.json": "{}",
      "frontend/src/main.js": "",
    },
    {
      language: "unused", image: "busybox:latest", command: "sh -c 'echo up'",
      manifests: ["backend/requirements.txt", "frontend/package.json", "package.json"],
      toolchains: [{ language: "unused", install: "test -f backend/requirements.txt && test -f frontend/package.json", dir: "." }],
    },
  ));
});

test("a Dockerfile with nothing to run is refused rather than built", () => {
  assert.throws(() => generateDockerfile({ ...base, command: "  " }), /needs a command to run/);
});

/* -------------------------------------------------------------------------- */
/* Workspace members and services that are not at the root                    */
/* -------------------------------------------------------------------------- */

test("a workspace member installs at the root and runs in its own directory", () => {
  // Two halves of one shape, and each one on its own is a broken image.
  //
  // The install belongs at the ROOT: the lockfile is there and `node_modules` is
  // hoisted there. The start command belongs to the MEMBER: `npm start` from
  // `/app` reads the workspace root's package.json, so it runs the wrong script
  // or none. `CMD` is not a `RUN`, so `inDir` cannot wrap it — `WORKDIR` is how a
  // Dockerfile says the same thing.
  const df = generateDockerfile({
    language: "node",
    command: "npm start",
    manifests: ["package.json", "package-lock.json", "apps/web/package.json"],
    toolchains: [{
      language: "node", version: "22", packageManager: "npm",
      install: "npm ci", build: "npm run build", dir: "apps/web", installDir: ".",
    } as never],
  });

  // Installed at the root, unwrapped.
  assert.match(df, /^RUN npm ci$/m);
  // Built in the member.
  assert.match(df, /^RUN \(cd apps\/web && npm run build\)$/m);
  // Started in the member.
  assert.match(df, /^WORKDIR \/app\/apps\/web$/m);
  // The hoisted binaries are the ones on PATH, and the member's own are too.
  assert.match(df, /^ENV PATH=.*\/app\/node_modules\/\.bin.*\/app\/apps\/web\/node_modules\/\.bin/m);
  // The member's manifest keeps its path, or the root install cannot see the
  // workspace it is installing for.
  assert.match(df, /^COPY apps\/web\/package\.json apps\/web\/$/m);
});

test("a service at the root still gets no WORKDIR of its own", () => {
  // The default has to stay exactly what it was: `WORKDIR /app`, named once. A
  // second `WORKDIR /app/.` would be harmless and wrong, and this is the case
  // every single-directory app takes.
  const df = generateDockerfile({
    language: "python", version: "3.12", command: "gunicorn app:app -b :$PORT",
    install: "pip install -r requirements.txt", manifests: ["requirements.txt"],
  });
  assert.equal(df.match(/^WORKDIR /gm)?.length, 1);
});
