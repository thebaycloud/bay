"use strict";
/**
 * `supersonic check` — the local dry run.
 *
 * Every failure asserted here is one that costs an eleven-minute round trip
 * today: a provisioned database, a Cloud Build, and a repair agent rediscovering
 * from `gcloud exited 1` something the file said in plain text before anything
 * started. What is being pinned is not the wording — it is that each one is found
 * WITHOUT a cloud, and that the exit path is non-zero, because the caller is an
 * agent in a loop and the exit code is the only part it is guaranteed to read.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { checkApp, renderCheck, renderService, secretWarnings } = require("../lib/check.js");
const { resolver, detector } = require("../lib/resolver.js");

const r = resolver();
const deps = { resolver: r, detect: detector() };

function repo(config, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-check-"));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  if (config) fs.writeFileSync(path.join(dir, "supersonic.json"), JSON.stringify(config));
  return dir;
}

const GOOD = {
  version: 1,
  services: [
    { name: "site", dir: "web", language: "static", install: "npm ci", build: "npm run build", outputDir: "dist", spaFallback: true },
    { name: "api", dir: "srv", language: "python", runtime: "python3.12", start: "uvicorn main:app --port $PORT", release: "alembic upgrade head", uses: ["database"], path: "/api" },
  ],
};

const GOOD_FILES = { "web/index.html": "<html>", "srv/main.py": "" };

// --- the happy path

test("a correct config passes with nothing to say", async () => {
  const { app, problems } = await checkApp(repo(GOOD, GOOD_FILES), deps);
  assert.deepEqual(problems, []);
  assert.equal(app.source, "config");
  assert.equal(app.services.length, 2);
  // Resources are once per app: the sibling asked for a database and the primary
  // did not, and the app still provisions one.
  assert.deepEqual(app.resources.database, { provider: "managed", engine: "postgres" });
});

test("each phase is printed as it would actually run", async () => {
  const { app } = await checkApp(repo(GOOD, GOOD_FILES), deps);
  const [site, api] = app.services.map((s) => renderService(s).join("\n"));

  // The subshell is the detail worth checking: each command is prefixed
  // independently and the lanes disagree about how they run them, so a bare
  // `cd web && …` installs and then fails with `cd: web: No such file or directory`.
  assert.match(site, /install {3}\(cd web && npm ci\)/);
  assert.match(site, /build {5}\(cd web && npm run build\)/);
  assert.match(site, /publish {3}web\/dist {2}· {2}unknown paths → index\.html/);
  assert.doesNotMatch(site, /start|health/);

  assert.match(api, /runner lane {2}· {2}\/api/);
  assert.match(api, /release {3}\(cd srv && alembic upgrade head\)/);
  assert.match(api, /start {5}\(cd srv && uvicorn main:app --port \$PORT\)/);
  assert.match(api, /health {4}GET \/ → 200/);
  assert.match(api, /uses {6}database/);
});

test("a service with no release says so, rather than leaving it out", async () => {
  // Blank here is a fact about this deploy, not a missing one: the difference is a
  // migration running once before traffic versus on every cold start and every
  // scale-out instance, concurrently.
  const { app } = await checkApp(repo({ services: [{ name: "api", language: "node", start: "node i.js" }] }, { "i.js": "" }), deps);
  assert.match(renderService(app.services[0]).join("\n"), /release {3}—.*nothing runs before traffic/);
});

// --- what it refuses

test("a static service that declared a migration is refused, by name", async () => {
  const dir = repo({ services: [{ name: "site", language: "static", outputDir: "dist", release: "alembic upgrade head" }] }, { "dist/index.html": "" });
  const { problems } = await checkApp(dir, deps);
  assert.equal(problems.length, 1, "one problem, not one per line of its message");
  assert.match(problems[0], /static lane does not implement: release/);
});

test("a build with nowhere to publish from is refused before it runs", async () => {
  // `outputDir: "."` means two opposite things and only the author can tell them
  // apart; publishing a raw source tree as a website is a silent wrong SUCCESS.
  const dir = repo({ services: [{ name: "site", language: "static", build: "npm run build" }] }, { "index.html": "" });
  const { problems } = await checkApp(dir, deps);
  assert.match(problems.join("\n"), /has a build command but no outputDir/);
});

test("a directory that is not there is one problem, not six", async () => {
  const { problems } = await checkApp(repo({ services: [{ name: "api", dir: "nowhere", language: "node" }] }), deps);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /directory "nowhere" does not exist/);
});

test("a runtime the platform does not have fails here, not forty lines into a pip log", async () => {
  // The pipeline already refuses this at deploy-pipeline.ts:1026. Without it here,
  // check would pass a repo the deploy refuses — the one outcome that makes a dry
  // run worth less than nothing.
  const dir = repo(
    { services: [{ name: "api", language: "python", runtime: "python3.15", start: "uvicorn main:app --port $PORT" }] },
    { "main.py": "", "pyproject.toml": '[project]\nrequires-python = ">=3.15,<4.0"\n' },
  );
  const { problems } = await checkApp(dir, deps);
  assert.match(problems.join("\n"), /needs Python >=3\.15,<4\.0 and the runner has 3\.14/);
});

test("a malformed config is a hard stop that names the file", async () => {
  const dir = repo(null, { "supersonic.json": "{oops" });
  const { app, problems } = await checkApp(dir, deps);
  assert.equal(app, null);
  assert.match(problems.join("\n"), /supersonic\.json is not valid JSON/);
});

test("two services claiming one path is refused", async () => {
  const dir = repo(null, {
    "supersonic.json": JSON.stringify({ services: [{ name: "a", language: "node", start: "x" }, { name: "b", language: "node", start: "y", path: "/" }] }),
  });
  const { problems } = await checkApp(dir, deps);
  assert.match(problems.join("\n"), /two services both serve \//);
});

// --- secrets

test("a secret with no value anywhere warns and does not fail", async () => {
  // It can only warn: a value already set on the deployed app is invisible from
  // here, so failing would refuse a correct config. `envNeeded` had the opposite
  // bug — the name was known to be required, said to nobody, and deployed anyway.
  const dir = repo({ services: [{ name: "api", language: "node", start: "node i.js", secrets: ["OPENAI_API_KEY"] }] }, { "i.js": "" });
  const { app, problems } = await checkApp(dir, deps);
  assert.deepEqual(problems, []);
  assert.match(secretWarnings(r, app, []).join(""), /OPENAI_API_KEY is declared under `secrets` and set nowhere here/);
  assert.deepEqual(secretWarnings(r, app, ["OPENAI_API_KEY"]), []);
});

// --- the report

test("the report names its source, and never claims a file that is not there", async () => {
  const { app, problems } = await checkApp(repo(GOOD, GOOD_FILES), deps);
  const text = renderCheck("supersonic.json", app, problems, []).join("\n");
  assert.match(text, /^supersonic\.json — 2 services, provisions postgres$/m);
  assert.match(text, /✓ nothing here fails before the build\. No GCP was touched\./);

  const inferred = renderCheck("supersonic.json", { ...app, source: "inferred" }, [], []).join("\n");
  assert.match(inferred, /inferred — there is no supersonic\.json/);
});

test("problems are counted, and the report says nothing was deployed", () => {
  const text = renderCheck("supersonic.json", null, ["✕ one\n  detail", "✕ two"], []).join("\n");
  assert.match(text, /^ {2}detail$/m);
  assert.match(text, /2 problems — nothing was deployed, and nothing would be\./);
});
