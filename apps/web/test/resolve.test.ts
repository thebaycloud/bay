import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve, validate, deriveLane, assertConsumed, missingSecrets, ResolveError, type ResolvedService } from "../lib/resolve";
import { parseAppConfig, ConfigError, platformOwned } from "../lib/app-config";

/** A repo on disk. The resolver checks the filesystem, so the tests need one. */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "resolve-"));
  for (const [path, body] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

const config = (o: unknown) => JSON.stringify(o);

/* ── the lane is derived, never authored ─────────────────────────────────── */

test("the lane follows from what the service is", () => {
  assert.equal(deriveLane({ language: "static" }), "static");
  assert.equal(deriveLane({ language: "node" }), "runner");
  assert.equal(deriveLane({ language: "python" }), "runner");
  assert.equal(deriveLane({ runtime: "python3.12" }), "runner");
  assert.equal(deriveLane({ runtime: "node22" }), "runner");
  // Tier 2: compiled, or simply without a prebuilt runner image here.
  assert.equal(deriveLane({ runtime: "java21" }), "buildpack");
  assert.equal(deriveLane({ runtime: "go1.23" }), "buildpack");
  assert.equal(deriveLane({ language: "other" }), "buildpack");
});

test("a committed Dockerfile outranks anything inferred about the language", () => {
  // The author already said how to build this.
  assert.equal(deriveLane({ language: "node", dockerfile: "Dockerfile" }), "container");
  assert.equal(deriveLane({ runtime: "rust1.80", dockerfile: "backend/Dockerfile" }), "container");
});

test("a static service stays static even with a Dockerfile in the repo", () => {
  assert.equal(deriveLane({ language: "static", outputDir: "dist" }), "static");
});

/* ── assert-consumed: a field no lane read is a hard failure ─────────────── */

test("a static service that declares a migration is refused, naming the field", () => {
  const dir = repo({
    "index.html": "<h1>hi</h1>",
    "supersonic.json": config({
      version: 1,
      services: [{ language: "static", outputDir: ".", release: "alembic upgrade head" }],
    }),
  });
  return resolve(dir).then((app) => {
    assert.throws(() => validate(app, dir), (e: Error) => {
      assert.ok(e instanceof ResolveError);
      assert.match(e.message, /static lane does not implement/);
      assert.match(e.message, /release/);
      // The remedy, not just the complaint.
      assert.match(e.message, /Move it to a service with a `start` command/);
      // Only what the AUTHOR wrote. `health` and `scale` carry resolver
      // defaults on every service and must never appear here.
      assert.doesNotMatch(e.message, /health|scale/);
      return true;
    });
  });
});

test("a static service that declares secrets is refused — there is nowhere to put them", () => {
  const dir = repo({
    "index.html": "<h1>hi</h1>",
    "supersonic.json": config({
      version: 1,
      services: [{ language: "static", outputDir: ".", secrets: ["STRIPE_SECRET_KEY"] }],
    }),
  });
  return resolve(dir).then((app) => {
    assert.throws(() => validate(app, dir), /does not implement[\s\S]*secrets/);
  });
});

test("a field the lane does implement passes", () => {
  const s = {
    name: "api", dir: ".", path: "/", lane: "runner" as const,
    release: "python manage.py migrate", start: "gunicorn app:app",
    spaFallback: false, uses: [], env: {}, buildEnv: {}, secrets: ["K"], envNeeded: [],
    health: { path: "/", expect: 200 },
    scale: { memory: "2Gi", cpu: 1, maxInstances: 10, timeout: 900, concurrency: 80, cpuBoost: true },
    declared: ["release", "start", "secrets"],
  } satisfies ResolvedService;
  assert.doesNotThrow(() => assertConsumed(s));
});

/* ── validate: what a 2-second local dry run can actually catch ──────────── */

test("a service directory that is not there is named, and does not cascade", () => {
  const dir = repo({
    "supersonic.json": config({ version: 1, services: [{ dir: "backend", language: "python", start: "uvicorn app:app" }] }),
  });
  return resolve(dir).then((app) => {
    assert.throws(() => validate(app, dir), (e: Error) => {
      assert.match(e.message, /directory "backend" does not exist/);
      // One failure about the missing directory, not six derived from it.
      assert.equal(e.message.split("\n").length, 1);
      return true;
    });
  });
});

test("a server with no start command is refused before anything is built", () => {
  const dir = repo({
    "app.py": "x = 1",
    "supersonic.json": config({ version: 1, services: [{ language: "python" }] }),
  });
  return resolve(dir).then((app) => {
    assert.throws(() => validate(app, dir), /runner lane runs a server and this service has no `start` command/);
  });
});

test("a build that names no output directory is refused rather than publishing the source tree", () => {
  const dir = repo({
    "package.json": "{}",
    "supersonic.json": config({
      version: 1,
      services: [{ language: "static", build: "npm run build" }],
    }),
  });
  return resolve(dir).then((app) => {
    assert.throws(() => validate(app, dir), /build command but no outputDir/);
  });
});

test("an outputDir that no build would create and that is not there is refused", () => {
  const dir = repo({
    "index.html": "<h1>hi</h1>",
    "supersonic.json": config({ version: 1, services: [{ language: "static", outputDir: "dist" }] }),
  });
  return resolve(dir).then((app) => {
    assert.throws(() => validate(app, dir), /outputDir "dist" does not exist and no build command would create it/);
  });
});

test("a nested Dockerfile and its context are checked, not assumed", () => {
  const dir = repo({
    "backend/Dockerfile": "FROM rust:1.80",
    "supersonic.json": config({
      version: 1,
      services: [{ dir: "backend", dockerfile: "backend/Dockerfile" }],
    }),
  });
  return resolve(dir).then((app) => {
    assert.equal(app.services[0].lane, "container");
    // Defaults to the service dir, which is the choice `repo-facts` declined to
    // make: it reported nested Dockerfiles without acting, because a build
    // context nobody had chosen was not usable.
    assert.equal(app.services[0].context, "backend");
    assert.doesNotThrow(() => validate(app, dir));
  });
});

test("a container service that also declares a start command is refused — its CMD is the start command", () => {
  const dir = repo({
    "Dockerfile": "FROM rust:1.80",
    "supersonic.json": config({ version: 1, services: [{ dockerfile: "Dockerfile", start: "./server" }] }),
  });
  return resolve(dir).then((app) => {
    assert.throws(() => validate(app, dir), /container lane does not implement[\s\S]*start/);
  });
});

test("a Dockerfile named in the config but absent from the repo is named", () => {
  const dir = repo({
    "supersonic.json": config({ version: 1, services: [{ dockerfile: "Dockerfile" }] }),
  });
  return resolve(dir).then((app) => {
    assert.throws(() => validate(app, dir), /dockerfile "Dockerfile" does not exist/);
  });
});

test("a service that uses a resource has it provisioned, whatever the config's source", async () => {
  // `uses` means the same thing for an inferred app as for a written one:
  // inference builds an AppConfig directly and never passes through the parser,
  // so normalising in only one of the two places is the bug, not the fix.
  const dir = repo({
    "app.py": "x = 1",
    "supersonic.json": config({
      version: 1,
      services: [{ language: "python", start: "uvicorn app:app", uses: ["database", "bucket"] }],
    }),
  });
  const app = await resolve(dir);
  assert.deepEqual(app.resources.database, { engine: "postgres" });
  assert.equal(app.resources.bucket, true);
  assert.doesNotThrow(() => validate(app, dir));
});

test("every problem is reported at once, not one per run", () => {
  const dir = repo({
    "a/x": "", "b/x": "",
    "supersonic.json": config({
      version: 1,
      services: [
        { name: "one", dir: "a", language: "python", path: "/" },
        { name: "two", dir: "b", language: "python", path: "/api" },
      ],
    }),
  });
  return resolve(dir).then((app) => {
    assert.throws(() => validate(app, dir), (e: Error) => {
      // A 2-second loop is only a win if it does not have to be run six times.
      assert.equal(e.message.split("\n").filter((l) => l.startsWith("✕")).length, 2);
      return true;
    });
  });
});

/* ── resources are once per app ──────────────────────────────────────────── */

test("a sibling that needs a database gets the app one provisioned", () => {
  // The provisioner bug: provisioning was driven by the PRIMARY service's plan,
  // so a static frontend on "/" with a Django API on "/api" provisioned nothing.
  const cfg = parseAppConfig(config({
    version: 1,
    services: [
      { name: "web", language: "static", outputDir: "dist", path: "/" },
      { name: "api", language: "python", start: "gunicorn app:app", path: "/api", needsDB: true },
    ],
  }));
  assert.deepEqual(cfg.resources?.database, { engine: "postgres" });
});

test("uses: [database] provisions one too, without the deprecated shorthand", () => {
  const cfg = parseAppConfig(config({
    version: 1,
    services: [{ language: "python", start: "x", uses: ["database"] }],
  }));
  assert.deepEqual(cfg.resources?.database, { engine: "postgres" });
});

test("an explicitly declared database keeps its version", () => {
  const cfg = parseAppConfig(config({
    version: 1,
    resources: { database: { engine: "postgres", version: "16" }, bucket: true },
    services: [{ language: "python", start: "x" }],
  }));
  assert.deepEqual(cfg.resources?.database, { engine: "postgres", version: "16" });
  assert.equal(cfg.resources?.bucket, true);
});

/* ── parse-time rules ────────────────────────────────────────────────────── */

test("a platform-owned variable is a parse error naming the variable", () => {
  for (const name of ["DATABASE_URL", "POSTGRES_USER", "PGPASSWORD", "DB_NAME", "PORT", "SUPERSONIC_RUN"]) {
    assert.throws(
      () => parseAppConfig(config({ version: 1, services: [{ env: { [name]: "x" } }] })),
      (e: Error) => {
        assert.ok(e instanceof ConfigError);
        assert.match(e.message, new RegExp(`"${name}" is set by the platform`));
        return true;
      },
      `${name} must be refused`,
    );
  }
});

test("the protected set covers every name databaseEnv writes, by derivation", () => {
  // 6 names were protected while 17 were written. Everything in the gap was a
  // user value the platform silently overwrote.
  assert.ok(platformOwned("POSTGRES_SERVER"));
  assert.ok(platformOwned("PGHOST"));
  assert.ok(platformOwned("DB_PASSWORD"));
  assert.ok(!platformOwned("STRIPE_SECRET_KEY"));
  assert.ok(!platformOwned("LOG_LEVEL"));
});

test("a platform-owned name is refused in buildEnv and secrets too, not only env", () => {
  assert.throws(() => parseAppConfig(config({ version: 1, services: [{ buildEnv: { PORT: "3000" } }] })), /set by the platform/);
  assert.throws(() => parseAppConfig(config({ version: 1, services: [{ secrets: ["DATABASE_URL"] }] })), /set by the platform/);
});

test("release and preDeploy are the same field and cannot disagree", () => {
  assert.throws(
    () => parseAppConfig(config({ version: 1, services: [{ release: "a", preDeploy: "b" }] })),
    /"preDeploy" and "release" are the same field/,
  );
  // The old name still works on its own.
  const cfg = parseAppConfig(config({ version: 1, services: [{ preDeploy: "alembic upgrade head" }] }));
  assert.equal(cfg.services[0].preDeploy, "alembic upgrade head");
});

test("v1 env-as-names and v2 env-as-values both parse, into different fields", () => {
  const v1 = parseAppConfig(config({ version: 1, services: [{ env: ["SECRET_KEY"] }] }));
  assert.deepEqual(v1.services[0].envNeeded, ["SECRET_KEY"]);
  assert.equal(v1.services[0].env, undefined);

  const v2 = parseAppConfig(config({ version: 1, services: [{ env: { LOG_LEVEL: "info" } }] }));
  assert.deepEqual(v2.services[0].env, { LOG_LEVEL: "info" });
  assert.equal(v2.services[0].envNeeded, undefined);
});

test("env that is neither form names both spellings", () => {
  assert.throws(
    () => parseAppConfig(config({ version: 1, services: [{ env: "LOG_LEVEL=info" }] })),
    /object of NAME: value, or an array of variable NAMES/,
  );
});

test("a memory value Cloud Run would reject is caught here instead", () => {
  assert.throws(
    () => parseAppConfig(config({ version: 1, services: [{ scale: { memory: "2GB" } }] })),
    /must look like "512Mi" or "2Gi"/,
  );
});

test("an unknown resource in uses is named", () => {
  assert.throws(
    () => parseAppConfig(config({ version: 1, services: [{ uses: ["redis"] }] })),
    /"redis" is not a resource/,
  );
});

/* ── secrets are enforced ────────────────────────────────────────────────── */

test("a declared secret with no value anywhere is reported by name", () => {
  const dir = repo({
    "app.py": "x = 1",
    "supersonic.json": config({
      version: 1,
      services: [{ language: "python", start: "x", secrets: ["STRIPE_SECRET_KEY", "SENTRY_DSN"] }],
    }),
  });
  return resolve(dir).then((app) => {
    assert.deepEqual(missingSecrets(app, ["SENTRY_DSN"]), ["STRIPE_SECRET_KEY"]);
    assert.deepEqual(missingSecrets(app, ["SENTRY_DSN", "STRIPE_SECRET_KEY"]), []);
  });
});

/* ── the simplest possible file stays the fastest path ───────────────────── */

test("a plain HTML folder resolves with no build and nothing to check", async () => {
  const dir = repo({
    "index.html": "<h1>hi</h1>",
    "supersonic.json": config({ version: 1, services: [{ language: "static", outputDir: "." }] }),
  });
  const app = await resolve(dir);
  assert.equal(app.source, "config");
  assert.equal(app.services[0].lane, "static");
  assert.equal(app.services[0].install, undefined);
  assert.equal(app.services[0].build, undefined);
  assert.doesNotThrow(() => validate(app, dir));
});

test("resolve records whether a human wrote the answer or the platform guessed", async () => {
  const dir = repo({
    "index.html": "<h1>hi</h1>",
    "supersonic.json": config({ version: 1, services: [{ language: "static", outputDir: "." }] }),
  });
  assert.equal((await resolve(dir)).source, "config");
});

test("a repo with no config and no detector says which command writes one", async () => {
  const dir = repo({ "index.html": "<h1>hi</h1>" });
  await assert.rejects(resolve(dir), /supersonic init/);
});

/* ── commands are wrapped for their directory once, here ─────────────────── */

test("a subdirectory command is wrapped in a subshell exactly once", async () => {
  const dir = repo({
    "frontend/package.json": "{}",
    "backend/app.py": "x = 1",
    "supersonic.json": config({
      version: 1,
      services: [
        { name: "web", dir: "frontend", language: "static", install: "npm ci", build: "npm run build", outputDir: "dist", path: "/" },
        { name: "api", dir: "backend", language: "python", start: "uvicorn app:app", path: "/api" },
      ],
    }),
  });
  const app = await resolve(dir);
  const web = app.services.find((s) => s.name === "web")!;
  assert.equal(web.install, "(cd frontend && npm ci)");
  // outputDir is repo-root relative, because that is what the uploader addresses.
  assert.equal(web.outputDir, "frontend/dist");
  assert.equal(app.services.find((s) => s.name === "api")!.start, "(cd backend && uvicorn app:app)");
});

test("the primary service comes first, whatever order it was declared in", async () => {
  const dir = repo({
    "frontend/package.json": "{}", "backend/app.py": "x = 1",
    "supersonic.json": config({
      version: 1,
      services: [
        { name: "api", dir: "backend", language: "python", start: "x", path: "/api" },
        { name: "web", dir: "frontend", language: "static", outputDir: ".", path: "/" },
      ],
    }),
  });
  const app = await resolve(dir);
  assert.equal(app.services[0].name, "web");
});
