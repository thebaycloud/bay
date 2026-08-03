import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDockerfile, baseImage, dockerignore, DockerfileError } from "../lib/dockerfile";

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

test("dependencies install before the source is copied", () => {
  // Layer caching, and why it matters: `COPY . .` before the install means every
  // one-character code change reinstalls everything, so a redeploy that should
  // take seconds takes minutes.
  const df = generateDockerfile({ ...base, install: "pip install -r requirements.txt" });

  const manifests = df.indexOf("requirements.txt*");
  const install = df.indexOf("RUN pip install");
  const source = df.indexOf("COPY . .");

  assert.ok(manifests < install, "manifests must be copied before the install");
  assert.ok(install < source, "the install layer must precede the source, or it is never reused");
});

test("a missing manifest is not an error, because most repos lack most of them", () => {
  // `COPY x* ./` tolerates a file that is not there; `COPY x ./` fails the build.
  // A Python repo has no Gemfile and that is the normal case, not a mistake.
  const df = generateDockerfile(base);
  const copies = df.split("\n").filter((l) => l.startsWith("COPY ") && l !== "COPY . .");

  assert.equal(copies.length, 1, "one COPY for every manifest, so a missing one cannot fail");
  for (const m of ["package.json", "requirements.txt", "go.mod", "Cargo.toml", "mix.exs"]) {
    assert.ok(copies[0].includes(`${m}*`), `${m} must be globbed, not required`);
  }
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
  const df = generateDockerfile({ ...base, install: "npm ci", build: "npm run build", language: "node" });

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

test("a Dockerfile with nothing to run is refused rather than built", () => {
  assert.throws(() => generateDockerfile({ ...base, command: "  " }), /needs a command to run/);
});
