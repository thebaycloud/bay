import { test } from "node:test";
import assert from "node:assert/strict";
import { railpackConfig, railpackArgs, railpackPrepareArgs } from "@/lib/railpack";
import type { BuildSpec } from "@/lib/detect";

const spec = (over: Partial<BuildSpec> = {}): BuildSpec => ({
  toolchains: [{ language: "node", packageManager: "npm", dir: "." }],
  language: "node",
  needs: [],
  confidence: "inferred",
  ...over,
});

// The whole point of handing the build to Railpack is to stop emitting install
// and cache layers ourselves. It is NOT to hand over the decision of what the
// app runs: `--run` and `x-supersonic-run` outrank everything in the repository
// because they are newer than all of it, and Railpack cannot see either. If
// Railpack's guess won here, a user who typed a command at deploy time would
// silently get a different one.
test("the command we resolved is the command Railpack is told to run", () => {
  const c = railpackConfig({ spec: spec({ command: "node server.js --port $PORT" }) });
  assert.equal(c.deploy?.startCommand, "node server.js --port $PORT");
});

// `frameworkBuildEnv` exists because of a real outage shape recorded in its own
// doc comment: these values are baked into the bundle, and setting them after the
// build "means the build ran without them and the value never reached the shipped
// JavaScript" — a prefixed Next app then fetches its JavaScript from the wrong
// path and renders blank. So they have to reach the BUILD.
//
// They must equally NOT be baked in as deploy variables. Everything in
// `deploymentEnv` is derived from the hostname this app answers on, and an image
// is not per-hostname: the same image is what a rollback re-places and what a
// second replica runs. Runtime env is injected when the process starts, and that
// is the only place it can be correct.
test("build-time framework env reaches the build and never the image", () => {
  const c = railpackConfig({
    spec: spec({ framework: "next" }),
    buildEnv: { NEXT_PUBLIC_BASE_PATH: "/app" },
  });
  assert.deepEqual(c.deploy?.variables, undefined, "runtime env is not the image's business");
  assert.deepEqual(railpackArgs({ spec: spec(), buildEnv: { NEXT_PUBLIC_BASE_PATH: "/app" } }), [
    "--env",
    "NEXT_PUBLIC_BASE_PATH=/app",
  ]);
});

// Railpack has exactly one `startCommand`; we run up to four processes out of one
// image — web, worker, cron and release — each a separate sandbox on the node
// started with its own command. `examples/shapes/crm` is all of them at once.
//
// So `startCommand` is the WEB command and nothing else. The release command in
// particular must not drift into it: release is the migration that runs once and
// exits before traffic moves, and an image whose default command is the migration
// would run it on every replica start.
test("the release command never becomes the image's start command", () => {
  const c = railpackConfig({
    spec: spec({ command: "gunicorn app:app --bind 0.0.0.0:$PORT", release: "python migrate.py" }),
  });
  assert.equal(c.deploy?.startCommand, "gunicorn app:app --bind 0.0.0.0:$PORT");
  assert.equal(JSON.stringify(c).includes("migrate.py"), false, "release is the platform's, not the image's");
});

// `needs` grows only from real build failures — the comment on it says so. Losing
// it silently would reintroduce every one of those failures at once.
test("apt packages the build needs are carried over", () => {
  const c = railpackConfig({ spec: spec({ needs: ["libvips-dev", "pkg-config"] }) });
  assert.deepEqual(c.buildAptPackages, ["libvips-dev", "pkg-config"]);
});

// Railpack spells the same language two ways in one file, and both spellings are
// in this config: the `provider` enum takes `golang`, while the mise tool key
// under `packages` takes `go`. Verified against `railpack schema` and against the
// generated mise config for examples/goapi, which reads `[tools] go = "1.25.0"`.
// Passing our own spelling to `provider` fails the enum; passing `golang` to
// `packages` installs nothing and the app builds against whatever Go the base
// image happens to carry.
test("a language is spelled Railpack's way, which is not one way", () => {
  const c = railpackConfig({
    spec: spec({
      language: "go",
      confidence: "certain",
      toolchains: [
        { language: "go", version: "1.25.0", versionFrom: "go.mod", packageManager: "go", dir: "." },
      ],
    }),
  });
  assert.equal(c.provider, "golang", "the provider enum has no `go`");
  assert.deepEqual(c.packages, { go: "1.25.0" }, "mise has no `golang`");
});

// WHEN WE MAY OVERRULE RAILPACK'S DETECTION, which is the decision this whole
// module turns on.
//
// We are adopting Railpack because its detection is better maintained than ours.
// Forcing `provider` from a guess of ours would throw that away and keep us
// owning the answer we just paid to stop owning. But `confidence: "certain"`
// does not mean "we are confident" — it means the repository or the USER said
// so in as many words, via `supersonic.json` or an answer to a question we
// asked. Railpack cannot see either of those, so there we are the better source.
//
// `inferred` and `guessed` are our framework-signal matching. That is precisely
// what Railpack does better, so we stand aside.
test("our guess does not overrule Railpack; a stated fact does", () => {
  const guessed = railpackConfig({ spec: spec({ language: "python", confidence: "inferred" }) });
  assert.equal(guessed.provider, undefined, "an inferred language is ours to stop guessing at");

  const stated = railpackConfig({ spec: spec({ language: "python", confidence: "certain" }) });
  assert.equal(stated.provider, "python");
});

// A version we resolved from a repo file is worth passing even though Railpack
// reads those files too, because ours resolves a monorepo the way the author
// means it — `.nvmrc` at the root, app in `frontend/` — and `DetectOptions.repoRoot`
// exists solely for that case.
//
// A version that came from OUR default is the opposite: it is a number we picked,
// competing with a number Railpack maintains. Forcing it would pin every
// unspecified app to whatever we last remembered to bump.
test("a version from the repo is passed; a version we invented is not", () => {
  const fromRepo = railpackConfig({
    spec: spec({
      confidence: "certain",
      toolchains: [{ language: "node", version: "22", versionFrom: ".nvmrc", packageManager: "npm", dir: "." }],
    }),
  });
  assert.deepEqual(fromRepo.packages, { node: "22" });

  const ourDefault = railpackConfig({
    spec: spec({
      confidence: "certain",
      toolchains: [
        { language: "node", version: "22", versionFrom: "platform default", packageManager: "npm", dir: "." },
      ],
    }),
  });
  assert.equal(ourDefault.packages, undefined, "Railpack's default is better kept than ours");
});

// The plan has to land where buildx will look for it: `-f` is resolved against
// the build context, and the context is the app directory. `--plan-out` is
// passed explicitly rather than relying on the default, because the default is
// relative to the working directory of whoever ran the command, and the deploy
// job's working directory is not the app.
test("the plan is written into the build context, beside the source", () => {
  const args = railpackPrepareArgs("/w/src", { spec: spec() });
  assert.deepEqual(args, ["prepare", "/w/src", "--plan-out", "/w/src/railpack-plan.json"]);
});

test("build env reaches prepare, because the plan is where it gets baked in", () => {
  const args = railpackPrepareArgs("/w/src", {
    spec: spec(),
    buildEnv: { NEXT_PUBLIC_BASE_PATH: "/app", VITE_BASE: "/app" },
  });
  assert.deepEqual(args.slice(4), ["--env", "NEXT_PUBLIC_BASE_PATH=/app", "--env", "VITE_BASE=/app"]);
});

// A DECLARED BUILD COMMAND MUST REACH RAILPACK, and the first real deploy is why.
//
// `examples/goapi` declares in supersonic.json:
//
//   "build": "go build -o /app/server ./cmd/server && go build -o /app/migrate ./cmd/migrate"
//   "start": "/app/server"
//
// Only the start command was being passed, so Railpack inferred a build of its
// own — `go build -ldflags="-w -s" -o out ./cmd/migrate`, which compiles the
// MIGRATION and names it `out`. The image then had no `/app/server` at all and
// the start command pointed at nothing. The build succeeded; the app could not
// exist.
//
// Same precedence rule as the provider and the version: a declared fact wins,
// an inference of ours stands aside — Railpack infers build commands better than
// we do, and that is most of why it is here.
test("a build command the repository declared is the build command Railpack runs", () => {
  const declared = railpackPrepareArgs("/w", {
    spec: spec({
      confidence: "certain",
      toolchains: [{ language: "go", packageManager: "go", dir: ".", build: "go build -o /app/server ./cmd/server" }],
    }),
  });
  assert.equal(declared.includes("--build-cmd"), true);
  assert.equal(declared[declared.indexOf("--build-cmd") + 1], "go build -o /app/server ./cmd/server");

  const inferred = railpackPrepareArgs("/w", {
    spec: spec({
      confidence: "inferred",
      toolchains: [{ language: "node", packageManager: "npm", dir: ".", build: "npm run build" }],
    }),
  });
  assert.equal(inferred.includes("--build-cmd"), false, "our guess must not overrule Railpack's");
});

// A toolchain with nothing to build says nothing, rather than passing an empty
// string — `--build-cmd ""` is a request to run no build, which is not the same
// as declining to have an opinion.
test("no declared build means no flag at all", () => {
  const args = railpackPrepareArgs("/w", { spec: spec({ confidence: "certain" }) });
  assert.equal(args.includes("--build-cmd"), false);
});

// THE DECLARED COMMAND, NOT A DERIVED VIEW OF IT.
//
// `examples/goapi` declares
//   "build": "go build -o /app/server ./cmd/server && go build -o /app/migrate ./cmd/migrate"
// and `detect()` puts only the FIRST half in `toolchains[0].build` — verified,
// it truncates at `&&`. Passing that to `--build-cmd` builds the server and not
// the migration, so the image has no `/app/migrate`, the release process fails
// with `/bin/sh: 1: /app/migrate: not found`, and the app never gets traffic.
// It happened in production twice before the cause was found.
//
// So the config's own string wins where there is one. `toolchains[0].build`
// remains the fallback for a build we INFERRED, where there is no declaration to
// prefer.
test("a declared build command is passed whole, not as detect's view of it", () => {
  const full = "go build -o /app/server ./cmd/server && go build -o /app/migrate ./cmd/migrate";
  const args = railpackPrepareArgs("/w", {
    spec: spec({
      confidence: "certain",
      toolchains: [{ language: "go", packageManager: "go", dir: ".", build: "go build -o /app/server ./cmd/server" }],
    }),
    declaredBuild: full,
  });
  assert.equal(args[args.indexOf("--build-cmd") + 1], full);
});

test("without a declaration the toolchain's build is still used", () => {
  const args = railpackPrepareArgs("/w", {
    spec: spec({
      confidence: "certain",
      toolchains: [{ language: "go", packageManager: "go", dir: ".", build: "go build ./..." }],
    }),
  });
  assert.equal(args[args.indexOf("--build-cmd") + 1], "go build ./...");
});
