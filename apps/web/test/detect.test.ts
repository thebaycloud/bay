import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detect, goMainPackage, serialisesRequests, type BuildSpec } from "../lib/detect";

/**
 * Fixture repositories, written to disk, because every rule in detect.ts is a
 * statement about files that exist.
 *
 * A mock filesystem would let a rule pass that reads the wrong filename, and
 * reading the wrong filename is the entire class of bug this module replaces: the
 * detector answered `pip install -r requirements.txt` for a project whose
 * dependencies were in `uv.lock`, and `main:app` for one whose module was
 * `app.main`.
 */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "detect-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

const pkg = (o: Record<string, unknown>) => JSON.stringify(o, null, 2);
const tc = (s: BuildSpec, language: string) => s.toolchains.find((t) => t.language === language);

/* -------------------------------------------------------------------------- */
/* Toolchains                                                                 */
/* -------------------------------------------------------------------------- */

test("a repo declaring two languages gets two toolchains", () => {
  // "Required, or every FastAPI+React monorepo breaks." A flat
  // packageManager/install cannot hold two, and a root holding both
  // requirements.txt and pnpm-lock.yaml matched the first row of the package-
  // manager table and never installed the frontend.
  const dir = repo({
    "requirements.txt": "fastapi\nuvicorn\n",
    "main.py": "app = 1\n",
    "package.json": pkg({ dependencies: { vite: "5" }, scripts: { build: "vite build" } }),
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
  });
  const s = detect(dir);

  assert.equal(s.toolchains.length, 2);
  assert.equal(tc(s, "python")!.install, "pip install --no-cache-dir -r requirements.txt");
  assert.equal(tc(s, "node")!.install, "corepack enable && pnpm install --frozen-lockfile");
  assert.equal(tc(s, "node")!.build, "pnpm run build");
  // The one that SERVES is first, and it is whichever the start command names.
  assert.equal(s.language, "python");
  assert.equal(s.toolchains[0].language, "python");
});

test("every toolchain carries its own directory, because inDir wraps by it", () => {
  const dir = repo({ "requirements.txt": "flask\n", "app.py": "" });
  const s = detect(dir, {}, "backend");
  assert.equal(s.toolchains[0].dir, "backend");
});

test("uv installs the project after the source copy, and the rest before it", () => {
  // `uv sync` builds the LOCAL project, and the cached layer runs before the
  // source is copied. Without --no-install-project the cached layer cannot build.
  const dir = repo({ "uv.lock": "version = 1\n", "pyproject.toml": "[project]\nname='x'\n", "main.py": "" });
  const t = tc(detect(dir), "python")!;

  assert.equal(t.packageManager, "uv");
  assert.match(t.install!, /--no-install-project/);
  assert.equal(t.installProject, "uv sync --frozen --no-dev");
});

test("a pyproject-only app forgoes the cached layer rather than emitting a broken one", () => {
  // `pip install .` has no --no-install-project equivalent, so it runs after
  // COPY . . — stated explicitly instead of producing a Dockerfile that cannot
  // build. This is the FastAPI template's exact shape.
  const dir = repo({ "pyproject.toml": "[project]\nname='x'\n", "main.py": "" });
  const t = tc(detect(dir), "python")!;

  assert.equal(t.install, undefined);
  assert.equal(t.installProject, "pip install --no-cache-dir .");
});

test("bun's text lockfile counts — listing only bun.lockb drops every modern bun repo", () => {
  const dir = repo({ "bun.lock": "{}", "package.json": pkg({ scripts: { start: "bun run index.ts" } }) });
  const t = tc(detect(dir), "node")!;
  assert.equal(t.packageManager, "bun");
  assert.equal(t.install, "bun install --frozen-lockfile");
});

test("npm without a lockfile installs rather than ci, which cannot run without one", () => {
  const dir = repo({ "package.json": pkg({ scripts: { start: "node index.js" } }) });
  assert.equal(tc(detect(dir), "node")!.install, "npm install");

  const locked = repo({ "package.json": pkg({ scripts: { start: "node i.js" } }), "package-lock.json": "{}" });
  assert.equal(tc(detect(locked), "node")!.install, "npm ci");
});

test("Java has a package manager and a build, which is the row Part 8 names as missing", () => {
  const maven = repo({ "pom.xml": "<project><maven.compiler.release>17</maven.compiler.release></project>" });
  const m = tc(detect(maven), "java")!;
  assert.equal(m.packageManager, "maven");
  assert.equal(m.install, "mvn -B -q -DskipTests dependency:go-offline");
  assert.equal(m.build, "mvn -B -DskipTests package");
  assert.equal(m.version, "17");

  const gradle = repo({ "build.gradle": "sourceCompatibility = JavaVersion.VERSION_21\n", "gradlew": "#!/bin/sh\n" });
  const g = tc(detect(gradle), "java")!;
  assert.equal(g.packageManager, "gradle");
  assert.equal(g.build, "./gradlew --no-daemon build -x test");
  assert.equal(g.version, "21");
});

test("the version and where it came from travel with the toolchain", () => {
  const dir = repo({
    "requirements.txt": "flask\n",
    "app.py": "",
    "pyproject.toml": 'requires-python = ">=3.11,<3.13"\n',
  });
  const t = tc(detect(dir), "python")!;
  assert.equal(t.version, "3.12");
  assert.equal(t.versionFrom, "pyproject.toml requires-python >=3.11,<3.13 → 3.12");
});

/* -------------------------------------------------------------------------- */
/* The start command, in order                                                */
/* -------------------------------------------------------------------------- */

test("the repo's own Procfile outranks anything inferred", () => {
  const dir = repo({
    "requirements.txt": "fastapi\nuvicorn\n",
    "main.py": "",
    "Procfile": "web: uvicorn custom:api --host 0.0.0.0 --port 8000\n",
  });
  const s = detect(dir);
  assert.equal(s.command, "uvicorn custom:api --host 0.0.0.0 --port $PORT");
  assert.equal(s.confidence, "certain");
  // …and the framework token is still found, because deploymentEnv needs it
  // whether or not the app declared its own start command.
  assert.equal(s.framework, "fastapi");
});

test("--run outranks the Procfile, because it is newer than the whole tree", () => {
  const dir = repo({ "requirements.txt": "fastapi\n", "main.py": "", "Procfile": "web: uvicorn main:app\n" });
  assert.equal(detect(dir, { run: "python worker.py" }).command, "python worker.py");
});

test("a literal port is rewritten to $PORT whatever row won", () => {
  // Cloud Run routes to $PORT and nothing else. A container that binds the
  // literal one never passes a health check, and the user is told the least
  // useful sentence the platform has: "didn't start on $PORT".
  const dir = repo({ "requirements.txt": "flask\n", "app.py": "" });
  for (const run of [
    "gunicorn app:app --bind 0.0.0.0:8000",
    "uvicorn main:app --port 8000",
    "rails s -p 3000",
    "gunicorn app:app -b :5000",
  ]) {
    assert.match(detect(dir, { run }).command!, /\$PORT/, run);
    assert.doesNotMatch(detect(dir, { run }).command!, /8000|3000|5000/, run);
  }
});

test("scripts.start yields to a static build, and only that row does", () => {
  // Create React App ships `"start": "react-scripts start"` — a dev server, in a
  // repo whose build writes a directory of files. Taking it containerises a site
  // that deploys correctly today on the static lane, around a bundler in watch
  // mode.
  const cra = repo({
    "package.json": pkg({ dependencies: { "react-scripts": "5" }, scripts: { start: "react-scripts start", build: "react-scripts build" } }),
  });
  const s = detect(cra);
  assert.equal(s.command, undefined);
  assert.equal(s.outputDir, "build");

  // An author who wrote it down in as many words still wins.
  const withProcfile = repo({
    "package.json": pkg({ dependencies: { "react-scripts": "5" }, scripts: { start: "react-scripts start" } }),
    "Procfile": "web: node server.js\n",
  });
  assert.equal(detect(withProcfile).command, "node server.js");
});

test("nothing to run and nothing built is a question, not an answer", () => {
  const dir = repo({ "go.mod": "module x\n\ngo 1.23\n" });
  // A Go module with no main package: there is something to install and nothing
  // that obviously serves.
  const s = detect(dir);
  assert.notEqual(s.confidence, "certain");
});

/* -------------------------------------------------------------------------- */
/* FRAMEWORK_START, and the three conditional rows                            */
/* -------------------------------------------------------------------------- */

test("Astro without an adapter is a static site, not a container with no entrypoint", () => {
  // `output:` alone is not the signal — `output: 'server'` with no adapter is a
  // configuration error, and without an adapter there is no dist/server/entry.mjs
  // to run.
  const noAdapter = repo({
    "package.json": pkg({ dependencies: { astro: "4" }, scripts: { build: "astro build" } }),
    "astro.config.mjs": "export default { output: 'server' }\n",
  });
  const s = detect(noAdapter);
  assert.equal(s.command, undefined);
  assert.equal(s.outputDir, "dist");

  const adapter = repo({
    "package.json": pkg({ dependencies: { astro: "4", "@astrojs/node": "8" }, scripts: { build: "astro build" } }),
    "astro.config.mjs": "import node from '@astrojs/node';\nexport default { adapter: node() }\n",
  });
  assert.equal(detect(adapter).command, "node ./dist/server/entry.mjs");
  assert.equal(detect(adapter).outputDir, undefined);
});

test("Next under output: 'export' is static — next start refuses an exported build", () => {
  const exported = repo({
    "package.json": pkg({ dependencies: { next: "15" }, scripts: { build: "next build" } }),
    "next.config.js": "module.exports = { output: 'export' }\n",
  });
  const s = detect(exported);
  assert.equal(s.command, undefined);
  assert.equal(s.outputDir, "out");
  assert.equal(s.framework, "next");     // the token survives; deploymentEnv needs it

  const server = repo({
    "package.json": pkg({ dependencies: { next: "15" }, scripts: { build: "next build" } }),
    "next.config.js": "module.exports = {}\n",
  });
  assert.equal(detect(server).command, "next start -p $PORT");
});

test("SvelteKit needs adapter-node for `node build`, which nothing checks today", () => {
  // deploy-agent/src/index.ts:155 sets `node build` for every @sveltejs/kit app
  // unconditionally. With adapter-static there is no build/index.js, so the
  // container exits 1 on a module it cannot find and the user is told the app did
  // not listen on $PORT.
  const staticAdapter = repo({
    "package.json": pkg({ dependencies: { "@sveltejs/kit": "2", "@sveltejs/adapter-static": "3" }, scripts: { build: "vite build" } }),
    "svelte.config.js": "import adapter from '@sveltejs/adapter-static';\n",
  });
  const s = detect(staticAdapter);
  assert.equal(s.command, undefined);
  assert.equal(s.outputDir, "build");

  const nodeAdapter = repo({
    "package.json": pkg({ dependencies: { "@sveltejs/kit": "2", "@sveltejs/adapter-node": "5" }, scripts: { build: "vite build" } }),
    "svelte.config.js": "import adapter from '@sveltejs/adapter-node';\n",
  });
  assert.equal(detect(nodeAdapter).command, "node build");
});

test("Django is started against its own project package, not a guessed one", () => {
  const dir = repo({
    "requirements.txt": "django\ngunicorn\n",
    "manage.py": 'os.environ.setdefault("DJANGO_SETTINGS_MODULE", "myproj.settings")\n',
    "myproj/wsgi.py": "application = 1\n",
  });
  const s = detect(dir);
  assert.equal(s.command, "gunicorn myproj.wsgi:application -b :$PORT");
  assert.equal(s.framework, "django");
  assert.equal(s.release, "python manage.py migrate --noinput");

  // …and when manage.py does not say, the directory holding wsgi.py does.
  const walked = repo({ "requirements.txt": "django\n", "manage.py": "", "site_cfg/wsgi.py": "" });
  assert.equal(detect(walked).command, "gunicorn site_cfg.wsgi:application -b :$PORT");
});

test("FastAPI in a subdirectory is uvicorn app.main:app, not main:app", () => {
  // uvicorn exits immediately on a module it cannot import, and the detector
  // answers `main:app` for every Python project.
  const nested = repo({ "requirements.txt": "fastapi\n", "app/main.py": "app = 1\n" });
  assert.equal(detect(nested).command, "uvicorn app.main:app --host 0.0.0.0 --port $PORT");
});

test("a server the app does not install is added to the install, not left to exit 127", () => {
  // `gunicorn app:app` is the correct way to serve Flask and what every tutorial
  // says — and gunicorn is a separate pip package a project written around
  // `flask run` does not have. The build is entirely green and the container dies
  // with exit 127.
  const missing = repo({ "requirements.txt": "flask\n", "app.py": "" });
  assert.match(tc(detect(missing), "python")!.install!, /pip install --no-cache-dir gunicorn/);

  const present = repo({ "requirements.txt": "flask\ngunicorn\n", "app.py": "" });
  assert.doesNotMatch(tc(detect(present), "python")!.install!, /install --no-cache-dir gunicorn/);
});

test("Rails, Laravel and a bare index.php each get the row they need", () => {
  const rails = repo({ "Gemfile": 'source "x"\ngem "rails"\ngem "pg"\n', "Gemfile.lock": "" });
  const r = detect(rails);
  assert.equal(r.command, "bundle exec rails s -b 0.0.0.0 -p $PORT");
  assert.equal(r.release, "bundle exec rails db:migrate");
  assert.deepEqual(r.database, { engine: "postgres", via: "pg" });

  const laravel = repo({ "composer.json": pkg({ require: { "laravel/framework": "^11" } }), "artisan": "" });
  assert.equal(detect(laravel).command, "php artisan serve --host 0.0.0.0 --port $PORT");

  const php = repo({ "composer.json": pkg({}), "index.php": "" });
  assert.equal(detect(php).command, "php -S 0.0.0.0:$PORT");
});

test("the PHP development servers are flagged, so concurrency can be pinned to 1", () => {
  // `php -S` and `php artisan serve` are single-threaded and serialise requests;
  // Cloud Run's default concurrency is 80. Shipping them at 80 silently is the
  // condition the two rows are accepted on.
  assert.equal(serialisesRequests("php -S 0.0.0.0:$PORT"), true);
  assert.equal(serialisesRequests("php artisan serve --host 0.0.0.0 --port $PORT"), true);
  assert.equal(serialisesRequests("php-fpm"), false);
  assert.equal(serialisesRequests("gunicorn app:app"), false);
});

/* -------------------------------------------------------------------------- */
/* Build                                                                      */
/* -------------------------------------------------------------------------- */

test("the build comes from the manifest, never from the framework name", () => {
  // Next, Vite, Nuxt and Remix all have scripts.build. That is why per-framework
  // Dockerfiles were never necessary.
  for (const dep of ["next", "nuxt", "vite", "@remix-run/node"]) {
    const dir = repo({ "package.json": pkg({ dependencies: { [dep]: "1" }, scripts: { build: "x" } }) });
    assert.equal(tc(detect(dir), "node")!.build, "npm run build", dep);
  }
  const noBuild = repo({ "package.json": pkg({ scripts: { start: "node i.js" } }) });
  assert.equal(tc(detect(noBuild), "node")!.build, undefined);
});

test("go build names one main package, because -o with several is an error", () => {
  const one = repo({ "go.mod": "module x\n\ngo 1.23\n", "cmd/api/main.go": "package main\n" });
  assert.deepEqual(goMainPackage(one), { pattern: "./cmd/api", sure: true });
  assert.equal(tc(detect(one), "go")!.build, "go build -o /app/server ./cmd/api");

  const root = repo({ "go.mod": "module x\n\ngo 1.23\n", "main.go": "package main\n", "cmd/tool/main.go": "package main\n" });
  assert.deepEqual(goMainPackage(root), { pattern: ".", sure: true });

  // Two binaries with no conventional name between them: `api` and `worker` are
  // both plausible servers, so nothing is chosen and nothing is built. That is
  // better than `./...`, which the Go toolchain rejects outright when `-o` names
  // a file.
  const several = repo({
    "go.mod": "module x\n\ngo 1.23\n",
    "cmd/api/main.go": "package main\n",
    "cmd/worker/main.go": "package main\n",
  });
  // `api` IS a conventional server name, so this one is decided rather than
  // ambiguous — which is the point of the convention list. The genuinely
  // ambiguous case is covered by its own test below.
  assert.deepEqual(goMainPackage(several), { pattern: "./cmd/api", sure: true });
  assert.equal(tc(detect(several), "go")!.build, "go build -o /app/server ./cmd/api");
});

test("Rust builds the binary Cargo.toml names", () => {
  const dir = repo({ "Cargo.toml": '[package]\nname = "myapi"\nversion = "0.1.0"\n', "Cargo.lock": "" });
  const s = detect(dir);
  assert.equal(tc(s, "rust")!.build, "cargo build --release");
  assert.equal(s.command, "/app/target/release/myapi");
});

/* -------------------------------------------------------------------------- */
/* Database                                                                   */
/* -------------------------------------------------------------------------- */

test("the database is read from dependency names, so a Django app still gets one", () => {
  // s.database gates Postgres, drives all 17 of databaseEnv's names, the proxy
  // sidecar and the proxyWait prefix. Its only writers today are the detector
  // subprocess and the planner, so taking the planner off the critical path
  // without this brings a Django repo up with no instance, no DATABASE_URL and no
  // proxy — green, and wrong.
  const cases: Array<[Record<string, string>, { engine: string; via: string } | undefined]> = [
    [{ "requirements.txt": "django\n", "manage.py": "" }, { engine: "postgres", via: "Django ORM" }],
    [{ "requirements.txt": "sqlalchemy\nasyncpg\n", "main.py": "" }, { engine: "postgres", via: "asyncpg" }],
    [{ "requirements.txt": "pymongo\n", "app.py": "" }, { engine: "mongodb", via: "pymongo" }],
    [{ "package.json": pkg({ dependencies: { "drizzle-orm": "1", mysql2: "3" } }) }, { engine: "mysql", via: "Drizzle" }],
    [{ "package.json": pkg({ dependencies: { mongoose: "8" } }) }, { engine: "mongodb", via: "Mongoose" }],
    [{ "package.json": pkg({ dependencies: { pg: "8" } }) }, { engine: "postgres", via: "pg" }],
    [{ "go.mod": "module x\n\ngo 1.23\n\nrequire github.com/jackc/pgx/v5 v5.0.0\n" }, { engine: "postgres", via: "pgx" }],
    [{ "package.json": pkg({ dependencies: { react: "19" } }) }, undefined],
  ];
  for (const [files, expected] of cases) {
    assert.deepEqual(detect(repo(files)).database, expected, JSON.stringify(Object.keys(files)));
  }
});

test("Prisma's own schema decides the engine", () => {
  const dir = repo({
    "package.json": pkg({ dependencies: { "@prisma/client": "6" } }),
    "prisma/schema.prisma": 'datasource db {\n  provider = "mysql"\n}\n',
  });
  assert.deepEqual(detect(dir).database, { engine: "mysql", via: "Prisma" });
});

/* -------------------------------------------------------------------------- */
/* Release                                                                    */
/* -------------------------------------------------------------------------- */

test("a Procfile release line finally runs", () => {
  // deploy-pipeline.ts:437 logs "the Procfile declares a 'release' process and it
  // did NOT run". This is the row that stops that being true.
  const dir = repo({
    "requirements.txt": "django\n",
    "manage.py": "",
    "Procfile": "web: gunicorn x.wsgi\nrelease: python manage.py migrate --fake-initial\n",
  });
  assert.equal(detect(dir).release, "python manage.py migrate --fake-initial");
});

test("the config outranks every inferred migration command", () => {
  const dir = repo({ "requirements.txt": "django\n", "manage.py": "" });
  assert.equal(detect(dir, { config: { release: "./bin/migrate" } }).release, "./bin/migrate");
  // `preDeploy` is the deprecated spelling and is still read.
  assert.equal(detect(dir, { config: { preDeploy: "./bin/old" } }).release, "./bin/old");
});

test("alembic and prisma are recognised without a config or a planner", () => {
  const alembic = repo({ "requirements.txt": "alembic\nfastapi\n", "main.py": "", "alembic.ini": "" });
  assert.equal(detect(alembic).release, "alembic upgrade head");

  const prisma = repo({
    "package.json": pkg({ dependencies: { "@prisma/client": "6" }, scripts: { start: "node i.js" } }),
    "prisma/schema.prisma": 'datasource db {\n  provider = "postgresql"\n}\n',
  });
  assert.equal(detect(prisma).release, "npx --no-install prisma migrate deploy");
});

/* -------------------------------------------------------------------------- */
/* needs                                                                      */
/* -------------------------------------------------------------------------- */

test("apt packages come from real failures, and an app with none asks for none", () => {
  assert.deepEqual(detect(repo({ "requirements.txt": "flask\n", "app.py": "" })).needs, []);

  const canvas = repo({ "package.json": pkg({ dependencies: { canvas: "3" }, scripts: { start: "node i.js" } }) });
  assert.deepEqual(detect(canvas).needs, ["libcairo2-dev", "libpango1.0-dev", "libjpeg-dev"]);

  const both = repo({ "requirements.txt": "mysqlclient\nweasyprint\n", "app.py": "" });
  assert.deepEqual(detect(both).needs, [
    "default-libmysqlclient-dev", "pkg-config", "libpango-1.0-0", "libpangoft2-1.0-0",
  ]);
});

/* -------------------------------------------------------------------------- */
/* Robustness                                                                 */
/* -------------------------------------------------------------------------- */

test("an unreadable manifest is silence, never a failed deploy", () => {
  const dir = repo({ "package.json": "{ not json", "Procfile": "web: node index.js\n" });
  const s = detect(dir);
  assert.equal(s.command, "node index.js");
  assert.equal(tc(s, "node")!.packageManager, "npm");
});

test("a malformed Procfile does not become a worse error from here", () => {
  // readProcfile refuses it on purpose, and the config path owns that message.
  // Detection turning it into "no start command" would send the user looking at
  // the wrong half of the problem.
  const dir = repo({ "requirements.txt": "fastapi\n", "main.py": "", "Procfile": "this is not a process line\n" });
  assert.doesNotThrow(() => detect(dir));
  assert.equal(detect(dir).command, "uvicorn main:app --host 0.0.0.0 --port $PORT");
});

test("an empty directory answers rather than throwing", () => {
  const s = detect(repo({}));
  assert.deepEqual(s.toolchains, []);
  assert.equal(s.language, "static");
  assert.equal(s.confidence, "guessed");
  assert.equal(s.command, undefined);
});

test("a Go module with several binaries builds the server, not a command that fails", () => {
  // `cmd/server` beside `cmd/migrate` is what a real Go service looks like the
  // moment it has migrations — the ordinary layout, not an exotic one. The old
  // answer for this was `go build -o /app/server ./...`, and `-o` naming a file
  // with a pattern matching several main packages is an ERROR in the Go
  // toolchain, not a choice. So it emitted a build guaranteed to fail.
  const dir = repo({
    "go.mod": "module api\n\ngo 1.24\n",
    "cmd/server/main.go": "package main\nfunc main(){}\n",
    "cmd/migrate/main.go": "package main\nfunc main(){}\n",
  });
  assert.deepEqual(goMainPackage(dir), { pattern: "./cmd/server", sure: true });
  assert.equal(tc(detect(dir), "go")!.build, "go build -o /app/server ./cmd/server");
});

test("Go binaries we cannot choose between produce no build at all", () => {
  // Better than a build that cannot succeed. No build leaves confidence at
  // "guessed", which is the caller's cue to ask; a failing build buys a confusing
  // log and a repair loop with nothing to repair.
  const dir = repo({
    "go.mod": "module api\n\ngo 1.24\n",
    "cmd/alpha/main.go": "package main\nfunc main(){}\n",
    "cmd/beta/main.go": "package main\nfunc main(){}\n",
  });
  assert.equal(goMainPackage(dir).pattern, null);
  const s = detect(dir);
  assert.equal(tc(s, "go")!.build, undefined);
  // …and it must not claim a binary the build never produces.
  assert.notEqual(s.command, "/app/server");
  assert.equal(s.confidence, "guessed");
});
