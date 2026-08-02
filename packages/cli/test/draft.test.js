"use strict";
/**
 * What `supersonic init` writes, against real directories on disk.
 *
 * Real trees rather than stubbed detector answers, because the thing under test is
 * exactly "does this read a repository correctly" — and the case that motivated
 * all of it, a `frontend/` + `backend/` root read as "Static site, 80%
 * confidence", is invisible to any test that hands the code a stack it already
 * agreed on.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildDraft, renderDraft, unknownsFor, declaredRuntime, frameworkToken, envNames } = require("../lib/draft.js");
const { resolver, detector } = require("../lib/resolver.js");
const { checkApp } = require("../lib/check.js");

const r = resolver();
const deps = { resolver: r, detect: detector() };

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-draft-"));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
}

/** The repository the whole plan is written about: a static frontend and a Python API. */
function splitRepo(extra = {}) {
  return tree({
    "frontend/package.json": JSON.stringify({ engines: { node: ">=20" }, scripts: { build: "vite build" }, dependencies: { vite: "^5" } }),
    "frontend/package-lock.json": "{}",
    "frontend/src/api.js": 'const b = import.meta.env.VITE_API_URL; const s = process.env.SENTRY_DSN;',
    "backend/pyproject.toml": '[project]\nname = "b"\nrequires-python = ">=3.12"\ndependencies = ["fastapi", "sqlalchemy"]\n',
    "backend/app/main.py": 'import os\nJWT = os.environ["JWT_SECRET"]\nDB = os.environ.get("DATABASE_URL")\n',
    ...extra,
  });
}

// --- the facts a file can state

test("runtime comes from what the repo declares, and is absent when it declares nothing", () => {
  const withEngines = tree({ "package.json": JSON.stringify({ engines: { node: ">=20.11.0" } }) });
  assert.equal(declaredRuntime(withEngines, withEngines, "node"), "node20");

  const withNvmrc = tree({ "package.json": "{}", ".nvmrc": "22.3.0\n" });
  assert.equal(declaredRuntime(withNvmrc, withNvmrc, "node"), "node22");

  // A range with no number is not a declaration, and pinning the app to whatever
  // the runner ships today would hold it back the next time the runner moves.
  const wildcard = tree({ "package.json": JSON.stringify({ engines: { node: "*" } }) });
  assert.equal(declaredRuntime(wildcard, wildcard, "node"), null);
  assert.equal(declaredRuntime(tree({ "package.json": "{}" }), ".", "node"), null);
});

test("python's runtime comes from requires-python, then .python-version", () => {
  const pyproject = tree({ "pyproject.toml": '[project]\nrequires-python = ">=3.12,<4.0"\n' });
  assert.equal(declaredRuntime(pyproject, pyproject, "python"), "python3.12");

  const pinned = tree({ ".python-version": "3.11.4\n" });
  assert.equal(declaredRuntime(pinned, pinned, "python"), "python3.11");
});

test("a root .nvmrc still speaks for an app in a subdirectory", () => {
  // The monorepo shape: the version is declared once, at the root, and the app
  // that has to honour it is two levels down.
  const repo = tree({ ".nvmrc": "20\n", "frontend/package.json": "{}" });
  assert.equal(declaredRuntime(path.join(repo, "frontend"), repo, "node"), "node20");
});

test("only frameworks the platform has a mapping for become a framework token", () => {
  assert.equal(frameworkToken("Next.js"), "next");
  assert.equal(frameworkToken("FastAPI"), "fastapi");
  // `framework` selects the proxy-awareness injection; a token nothing maps reads
  // as configured and does nothing at all.
  assert.equal(frameworkToken("Node"), null);
  assert.equal(frameworkToken("Static site"), null);
  assert.equal(frameworkToken("Go"), null);
});

// --- env var names

test("env names are found in both languages and in every spelling", () => {
  const dir = tree({
    "a.js": 'process.env.API_TOKEN; process.env["OTHER_KEY"]; import.meta.env.VITE_URL;',
    "b.py": 'os.environ["JWT_SECRET"]\nos.environ.get("MAIL_KEY")\nos.getenv("SENTRY_DSN")\n',
  });
  const { secrets, buildEnv } = envNames(dir, { platformOwned: r.platformOwned });
  assert.deepEqual(secrets, ["API_TOKEN", "JWT_SECRET", "MAIL_KEY", "OTHER_KEY", "SENTRY_DSN"]);
  assert.deepEqual(buildEnv, ["VITE_URL"]);
});

const MANAGED_DB = { provider: "managed", engine: "postgres" };

test("names the platform writes are never offered as secrets", () => {
  // Offering one would produce a config parseAppConfig refuses outright — a draft
  // that cannot be parsed is worse than no draft.
  const dir = tree({ "a.js": "process.env.DATABASE_URL; process.env.PORT; process.env.PGHOST; process.env.NODE_ENV; process.env.REAL_KEY;" });
  const { secrets } = envNames(dir, { platformOwned: (n) => r.platformOwned(n, MANAGED_DB) });
  assert.deepEqual(secrets, ["REAL_KEY"]);
});

test("an app with no database of ours keeps the connection names as its own", () => {
  // The other half of the same rule. Nothing is provisioned, so nothing writes
  // these, so they are ordinary secrets the author has to supply — and a draft
  // that hid them would be hiding the variables the app cannot start without.
  const dir = tree({ "a.js": "process.env.DATABASE_URL; process.env.PORT; process.env.REAL_KEY;" });
  const { secrets } = envNames(dir, { platformOwned: (n) => r.platformOwned(n, undefined) });
  assert.deepEqual(secrets, ["DATABASE_URL", "REAL_KEY"]);
});

test("somebody else's dependencies are not this app's environment", () => {
  const dir = tree({
    "index.js": "process.env.MINE;",
    "node_modules/pkg/index.js": "process.env.THEIRS;",
    "dist/bundle.js": "process.env.BUILT;",
  });
  assert.deepEqual(envNames(dir, { platformOwned: r.platformOwned }).secrets, ["MINE"]);
});

// --- the draft

test("a frontend+backend repo drafts two services, browser-facing on /", async () => {
  const repo = splitRepo();
  const { config } = await buildDraft(repo, deps);
  assert.equal(config.services.length, 2);

  const [primary, sibling] = config.services;
  assert.equal(primary.name, "frontend");
  assert.equal(primary.path, "/");
  assert.equal(primary.language, "static");
  assert.equal(primary.outputDir, "dist");
  assert.equal(sibling.name, "backend");
  assert.equal(sibling.path, "/api");
  assert.equal(sibling.runtime, "python3.12");
  assert.equal(sibling.framework, "fastapi");
  // `app.main:app`, not `main:app`: uvicorn exits immediately on a module it
  // cannot import, and the detector answers `main:app` for every Python project.
  assert.match(sibling.start, /uvicorn app\.main:app/);
  assert.match(sibling.start, /\$PORT/);
});

test("the draft is a config the parser accepts and the resolver validates", async () => {
  // The whole promise of `init` is that the next command works. A draft that fails
  // its own `check` would put the agent back to authoring from nothing, which is
  // the one thing this is meant to stop.
  const repo = splitRepo();
  const { config } = await buildDraft(repo, deps);
  fs.writeFileSync(path.join(repo, "supersonic.json"), JSON.stringify(config, null, 2));

  r.parseAppConfig(JSON.stringify(config));
  const { problems } = await checkApp(repo, deps);
  assert.deepEqual(problems, []);
});

test("a static service is never handed a field its lane cannot act on", async () => {
  const { config } = await buildDraft(splitRepo(), deps);
  const site = config.services[0];
  for (const field of ["runtime", "framework", "uses", "release", "needsDB"]) {
    assert.equal(field in site, false, `static service should not declare ${field}`);
  }
  // The database is still ANSWERED, one level up: provisioning is once per app,
  // and driving it off the primary service alone is how a static frontend beside a
  // Python API provisioned nothing at all.
  assert.deepEqual(config.resources, { database: { engine: "postgres" } });
});

test("placeholders are inert: they name the field without declaring it", async () => {
  const { config } = await buildDraft(splitRepo(), deps);
  const [site, api] = config.services;
  assert.equal(site.spaFallback, false);
  assert.deepEqual(site.secrets, []);
  assert.equal(api.release, "");
  // declaredFields treats all three as unwritten, so assert-consumed cannot fire
  // on a field this tool put there rather than the author.
  const app = await r.resolve(path.dirname(writeConfig(config)), detector());
  for (const s of app.services) r.assertConsumed(s);
});

function writeConfig(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-draft-cfg-"));
  for (const s of config.services) fs.mkdirSync(path.join(dir, s.dir ?? "."), { recursive: true });
  const file = path.join(dir, "supersonic.json");
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

test("a repo whose only app is in a subdirectory is read there, not at its root", async () => {
  // Inference declines below two parts, so the CLI used to have nothing but the
  // root to detect — and the root of this repo is "Static site, 80% confidence".
  const repo = tree({
    "backend/requirements.txt": "django\npsycopg2-binary\n",
    "backend/manage.py": "",
    "docs/package.json": JSON.stringify({ scripts: { build: "x" } }),
  });
  const { config } = await buildDraft(repo, deps);
  assert.equal(config.services.length, 1);
  assert.equal(config.services[0].dir, "backend");
  assert.equal(config.services[0].language, "python");
  assert.equal(config.services[0].framework, "django");
});

test("a hand-written root Dockerfile outranks anything detected about the language", async () => {
  const repo = tree({
    "Dockerfile": "FROM node:22\nCMD [\"node\",\"x.js\"]\n",
    "package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { vite: "^5" } }),
  });
  const { config } = await buildDraft(repo, deps);
  const [svc] = config.services;
  assert.equal(svc.dockerfile, "Dockerfile");
  assert.equal(svc.context, ".");
  // No `language`: deriveLane checks `static` before it checks the Dockerfile, so
  // calling this Vite repo static would route it away from the file its author wrote.
  assert.equal("language" in svc, false);
  assert.equal(r.deriveLane(svc), "container");
});

test("a folder of plain HTML is a static site with nothing to build", async () => {
  const repo = tree({ "index.html": "<html>" });
  const { config } = await buildDraft(repo, deps);
  assert.equal(config.services[0].language, "static");
  assert.equal(config.services[0].outputDir, ".");
  assert.equal(config.services[0].build, undefined);
});

// --- the questions

test("the undetermined block asks only what is live for this repo", async () => {
  const repo = splitRepo({ "frontend/dist/index.html": "<html>" });
  const { config, candidates } = await buildDraft(repo, deps);
  const asked = unknownsFor(repo, config, candidates).map(([q]) => q).join("\n");

  assert.match(asked, /migration before traffic/);
  assert.match(asked, /serve index\.html/);
  assert.match(asked, /VITE_API_URL at BUILD time/);
  assert.match(asked, /JWT_SECRET.*SENTRY_DSN|SENTRY_DSN.*JWT_SECRET/);
  // A committed output directory is either the deliverable or last month's build,
  // and the two are the same bytes on disk.
  assert.match(asked, /frontend\/dist.*deliverable, or stale/);
  // Not asked: the frontend answers a browser, so it owns `/` and that is not a guess.
  assert.doesNotMatch(asked, /the one on \//);
});

test("who owns / is asked only when both services are servers", async () => {
  const repo = tree({
    "api/package.json": JSON.stringify({ scripts: { start: "node i.js" }, dependencies: { express: "^4" } }),
    "api/i.js": "",
    "worker/package.json": JSON.stringify({ scripts: { start: "node w.js" }, dependencies: { fastify: "^4" } }),
    "worker/w.js": "",
  });
  const { config, candidates } = await buildDraft(repo, deps);
  const asked = unknownsFor(repo, config, candidates).map(([q]) => q).join("\n");
  assert.match(asked, /is `\w+` the one on \/ \?/);
});

test("a migration is not asked about a service with no database", async () => {
  // A question with an obviously empty answer trains people to skip the block, and
  // the one that mattered gets skipped with it.
  const repo = tree({
    "package.json": JSON.stringify({ scripts: { start: "node i.js" }, dependencies: { express: "^4" } }),
    "i.js": "",
  });
  const { config, candidates } = await buildDraft(repo, deps);
  assert.doesNotMatch(unknownsFor(repo, config, candidates).map(([q]) => q).join("\n"), /migration/);
});

test("the Django ${MODULE} placeholder is raised as a question, not shipped silently", async () => {
  // Unset, the shell expands it to nothing and the container dies on
  // `gunicorn .wsgi` — a placeholder that looks like a command right up until it runs.
  const repo = tree({ "requirements.txt": "django\n", "manage.py": "" });
  const { config, candidates } = await buildDraft(repo, deps);
  assert.match(unknownsFor(repo, config, candidates).map(([q]) => q).join("\n"), /\$\{MODULE\}/);
});

// --- what it prints

test("the output says it is a draft, and says what it could not determine", async () => {
  const repo = splitRepo();
  const { config, candidates } = await buildDraft(repo, deps);
  const text = renderDraft("supersonic.json", config, unknownsFor(repo, config, candidates)).join("\n");

  assert.match(text, /^Wrote supersonic\.json — 2 services detected\./);
  assert.match(text, /^ {2}\/ +frontend +static +npm ci && npm run build → dist$/m);
  assert.match(text, /^ {2}\/api +backend +python +uvicorn/m);
  assert.match(text, /things I could not determine — check them:/);
  // The sentence that makes the whole thing safe: this is a detector that has been
  // confidently wrong, and its answer is now reviewable rather than invisible.
  assert.match(text, /This is a draft, from a detector that has been confidently wrong before\./);
  assert.match(text, /supersonic check/);
});
