import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SCALE } from "../lib/lanes";
import { resolve, resolveFrom, validate, deriveLane, laneFor, assertConsumed, missingSecrets, ResolveError, type ResolvedService } from "../lib/resolve";
import { parseAppConfig, ConfigError, platformOwned, usesDatabase, planFromConfig, type ServiceConfig } from "../lib/app-config";

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

test("the lane follows from whether the repository builds its own image", () => {
  assert.equal(deriveLane({ language: "static" }), "static");

  // EVERY VERSION IS THE SAME ANSWER NOW, and the rows this test used to have
  // are the reason that matters. `node` and `python` went to the runner — one
  // shared prebuilt image per language — while `python3.12` went to buildpacks,
  // because the runner HAD 3.14 and an app asking for 3.12 got 3.14 and died at
  // start inside its own code. A pinned version was a demotion away from the
  // runner; there is no runner left to be demoted from, and an image built for
  // the version the app asked for is what every one of these gets.
  const services: ServiceConfig[] = [
    { language: "node" }, { language: "python" }, { language: "other" },
    { runtime: "python3.14" }, { runtime: "python3.12" },
    { runtime: "node24" }, { runtime: "node22" },
    { runtime: "java21" }, { runtime: "go1.23" },
  ];
  for (const service of services) {
    assert.equal(deriveLane(service), "buildpack", `${JSON.stringify(service)} builds its own image`);
  }
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
    name: "api", dir: ".", path: "/", lane: "buildpack" as const,
    release: "python manage.py migrate", start: "gunicorn app:app",
    spaFallback: false,
  processes: [], uses: [], env: {}, buildEnv: {}, secrets: ["K"], envNeeded: [],
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
    assert.throws(() => validate(app, dir), /lane runs a server and this service has no `start` command/);
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
  assert.deepEqual(app.resources.database, { provider: "managed", engine: "postgres" });
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
  assert.deepEqual(cfg.resources?.database, { provider: "managed", engine: "postgres" });
});

test("uses: [database] provisions one too, without the deprecated shorthand", () => {
  const cfg = parseAppConfig(config({
    version: 1,
    services: [{ language: "python", start: "x", uses: ["database"] }],
  }));
  assert.deepEqual(cfg.resources?.database, { provider: "managed", engine: "postgres" });
});

test("an explicitly declared database keeps its version", () => {
  const cfg = parseAppConfig(config({
    version: 1,
    resources: { database: { engine: "postgres", version: "16" }, bucket: true },
    services: [{ language: "python", start: "x" }],
  }));
  assert.deepEqual(cfg.resources?.database, { provider: "managed", engine: "postgres", version: "16" });
  assert.equal(cfg.resources?.bucket, true);
});

/* ── bring your own database ─────────────────────────────────────────────── */

test("a database declared external is not provisioned and names its secret", () => {
  const cfg = parseAppConfig(config({
    version: 1,
    resources: { database: { provider: "external", engine: "postgres", urlFrom: "DATABASE_URL" } },
    services: [{ language: "python", start: "x", uses: ["database"] }],
  }));
  assert.deepEqual(cfg.resources?.database, { provider: "external", engine: "postgres", urlFrom: "DATABASE_URL" });
});

test("an external database must say which secret holds its URL", () => {
  assert.throws(
    () => parseAppConfig(config({
      version: 1,
      resources: { database: { provider: "external" } },
      services: [{ language: "python", start: "x" }],
    })),
    /needs "urlFrom"/,
  );
});

test("urlFrom cannot name a variable the platform always owns", () => {
  assert.throws(
    () => parseAppConfig(config({
      version: 1,
      resources: { database: { provider: "external", urlFrom: "PORT" } },
      services: [{ language: "python", start: "x" }],
    })),
    /"PORT" is set by the platform/,
  );
});

test("provider must be managed or external, and says so", () => {
  assert.throws(
    () => parseAppConfig(config({
      version: 1,
      resources: { database: { provider: "supabase", urlFrom: "DATABASE_URL" } },
      services: [{ language: "python", start: "x" }],
    })),
    /must be "managed".*or "external"/,
  );
});

test("an engine the platform cannot provision points at the external escape hatch", () => {
  assert.throws(
    () => parseAppConfig(config({
      version: 1,
      resources: { database: { engine: "mysql" } },
      services: [{ language: "python", start: "x" }],
    })),
    /can be declared with "provider": "external"/,
  );
});

/* ── parse-time rules ────────────────────────────────────────────────────── */

const MANAGED = { database: { engine: "postgres" } };

test("a platform-owned variable is a parse error naming the variable", () => {
  for (const name of ["DATABASE_URL", "POSTGRES_USER", "PGPASSWORD", "DB_NAME", "PORT", "SUPERSONIC_RUN"]) {
    assert.throws(
      () => parseAppConfig(config({ version: 1, resources: MANAGED, services: [{ env: { [name]: "x" } }] })),
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
  const managed = { provider: "managed", engine: "postgres" } as const;
  assert.ok(platformOwned("POSTGRES_SERVER", managed));
  assert.ok(platformOwned("PGHOST", managed));
  assert.ok(platformOwned("DB_PASSWORD", managed));
  assert.ok(!platformOwned("STRIPE_SECRET_KEY", managed));
  assert.ok(!platformOwned("LOG_LEVEL", managed));
});

test("PORT and SUPERSONIC_* are ours whatever the app declares", () => {
  // Nothing releases these: Cloud Run assigns the port, and SUPERSONIC_* is the
  // platform's own namespace. They do not depend on who supplies the database.
  for (const db of [undefined, { provider: "managed", engine: "postgres" } as const,
                    { provider: "external", urlFrom: "DATABASE_URL" } as const]) {
    assert.ok(platformOwned("PORT", db));
    assert.ok(platformOwned("SUPERSONIC_RUN", db));
  }
});

test("database names belong to the app when the platform does not supply one", () => {
  // The refusal that excluded every app with infrastructure of its own. The
  // original reasoning — "somebody setting DATABASE_URL is describing a database
  // they do not have" — is exactly inverted for an app on Supabase.
  const external = { provider: "external", urlFrom: "DATABASE_URL" } as const;
  assert.ok(!platformOwned("DATABASE_URL", external));
  assert.ok(!platformOwned("PGHOST", external));
  assert.ok(!platformOwned("DATABASE_URL", undefined));
});

test("an app that owns its database may declare the connection names", () => {
  const cfg = parseAppConfig(config({
    version: 1,
    resources: { database: { provider: "external", urlFrom: "DATABASE_URL" } },
    services: [{ language: "python", start: "x", uses: ["database"], secrets: ["DATABASE_URL"], env: { PGSSLMODE: "require" } }],
  }));
  assert.deepEqual(cfg.services[0].secrets, ["DATABASE_URL"]);
  assert.deepEqual(cfg.services[0].env, { PGSSLMODE: "require" });
});

test("refusing a database name points at the way to declare one", () => {
  // A refusal that only says no leaves the author with no next move. This is the
  // whole reason the name was refused, so it is the right place to say it.
  assert.throws(
    () => parseAppConfig(config({ version: 1, resources: MANAGED, services: [{ env: { DATABASE_URL: "x" } }] })),
    /"provider": "external", "urlFrom": "DATABASE_URL"/,
  );
});

test("a platform-owned name is refused in buildEnv and secrets too, not only env", () => {
  assert.throws(() => parseAppConfig(config({ version: 1, services: [{ buildEnv: { PORT: "3000" } }] })), /set by the platform/);
  assert.throws(
    () => parseAppConfig(config({ version: 1, resources: MANAGED, services: [{ secrets: ["DATABASE_URL"] }] })),
    /set by the platform/,
  );
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
    () => parseAppConfig(config({ version: 1, services: [{ uses: ["kafka"] }] })),
    /"kafka" is not a resource/,
  );
});

test("a resource we run, and one we refuse, both parse", () => {
  // Accepted here and answered later, and the two answers differ: redis becomes
  // a process beside the app on a node, elasticsearch is refused by name with
  // the reason. Rejecting either at parse time would make "we do not run that"
  // indistinguishable from "you spelled it wrong", and the first deserves an
  // explanation the second does not.
  for (const kind of ["redis", "elasticsearch"]) {
    assert.doesNotThrow(() => parseAppConfig(config({ version: 1, services: [{ uses: [kind] }] })));
  }
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

test("an external database's URL is a required secret without anyone listing it", () => {
  // Required by construction: the app said it has a database and said where the
  // connection string lives, and nothing else supplies one. Left out of this set
  // it would surface as a driver error inside the customer's own stack trace.
  const dir = repo({
    "app.py": "x = 1",
    "supersonic.json": config({
      version: 1,
      resources: { database: { provider: "external", urlFrom: "DATABASE_URL" } },
      services: [{ language: "python", start: "x", uses: ["database"] }],
    }),
  });
  return resolve(dir).then((app) => {
    assert.deepEqual(missingSecrets(app, []), ["DATABASE_URL"]);
    assert.deepEqual(missingSecrets(app, ["DATABASE_URL"]), []);
  });
});

test("a managed database asks for no secret of its own", () => {
  const dir = repo({
    "app.py": "x = 1",
    "supersonic.json": config({
      version: 1,
      services: [{ language: "python", start: "x", uses: ["database"] }],
    }),
  });
  return resolve(dir).then((app) => assert.deepEqual(missingSecrets(app, []), []));
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

test("uses: [database] provisions a database on the path the pipeline actually reads", () => {
  // It did not, for one deploy. The parser read `uses`, validate accepted it and
  // `supersonic check` printed "uses database" — then the pipeline asked
  // svc.needsDB, got undefined, and provisioned nothing. The app deployed with a
  // config saying it needed Postgres and an environment that had none, and the
  // first thing to notice was a pydantic error inside the release job.
  const cfg = parseAppConfig(config({
    version: 1,
    services: [{ language: "python", start: "x", uses: ["database"] }],
  }));
  assert.equal(usesDatabase(cfg.services[0]), true);
  // The v1 field the pipeline reads has to agree with the v2 field the user wrote.
  assert.equal(planFromConfig(cfg).needsDB, true);
});

test("the v1 spelling still answers the same question", () => {
  const cfg = parseAppConfig(config({ version: 1, services: [{ language: "python", start: "x", needsDB: true }] }));
  assert.equal(usesDatabase(cfg.services[0]), true);
  assert.equal(planFromConfig(cfg).needsDB, true);
});

test("a service wanting no database still says so", () => {
  const cfg = parseAppConfig(config({ version: 1, services: [{ language: "python", start: "x" }] }));
  assert.equal(usesDatabase(cfg.services[0]), false);
  assert.equal(planFromConfig(cfg).needsDB, undefined);
});

test("the deploy and the CLI answer the lane through one function", () => {
  // The defect this guards: `deriveLane` was called by the CLI and by
  // `resolveService`, and by nothing in the deploy — `deploy-pipeline.ts` derived
  // its own lane inline from a string match on the detector's runtime, with its
  // own rules. So `assertConsumed` validated a service against a lane the deploy
  // might not take, and a config could resolve to one lane in `supersonic check`
  // and deploy on another with nobody informed. One function is the fix, and it
  // outlives the lanes it was arbitrating between.
  //
  // The truth table used to have four axes. Two are gone with the runner: RUNNER
  // itself, and whether the deploying agent supplied a `--run` that outranked a
  // committed Dockerfile — an override that only made sense while there was a
  // runner to fall back to. What is left is the question that decides anything:
  // does the repository build its own image.
  const cases: Array<[string, boolean, string]> = [
    ["python3.14", false, "buildpack"],
    ["python3.14", true,  "container"],
    ["node24",     false, "buildpack"],
    ["go1.23",     true,  "container"],
    ["go1.23",     false, "buildpack"],
    ["",           true,  "container"],
    ["",           false, "buildpack"],
  ];

  for (const [runtime, dockerfile, expected] of cases) {
    assert.equal(
      laneFor({ runtime, dockerfile: dockerfile ? "Dockerfile" : undefined }),
      expected,
      `runtime=${JSON.stringify(runtime)} dockerfile=${dockerfile}`,
    );
  }
});

test("a written config answers for the lane it describes, with no deploy overrides", () => {
  // `deriveLane` is a thin wrapper, so the CLI cannot drift from the deploy — but
  // it still answers the question the CLI is asking: what does this FILE say?
  //
  // It used to have a second job. `runnerEnabled` was a property of the CONTROL
  // PLANE rather than of the config, so this defaulted it to enabled rather than
  // leaking a server env var into `supersonic check`. With the runner gone there
  // is no control-plane state in the answer at all, which is a stronger version
  // of the same guarantee.
  assert.equal(deriveLane({ language: "node" }), laneFor({ language: "node" }));
  assert.equal(deriveLane({ runtime: "python3.14" }), "buildpack");
  assert.equal(deriveLane({ runtime: "python3.14", dockerfile: "Dockerfile" }), "container");
});

test("a worker-only service is valid without a start command", () => {
  // `start` is the older spelling of exactly one shape — one HTTP server on one
  // port — so demanding it from a Telegram bot is the schema telling a
  // worker-only app to pretend to be a web server. `supersonic check` refused
  // exactly that config until processes became a thing a service could declare.
  const bot = parseAppConfig(JSON.stringify({
    services: [{ language: "python", processes: { bot: { command: "python bot.py" } } }],
  }));

  assert.doesNotThrow(() => validate(resolveFrom(bot, "config"), process.cwd()));

  // And a service that declares neither is still refused, with the alternative named.
  const nothing = parseAppConfig(JSON.stringify({ services: [{ language: "python" }] }));
  assert.throws(() => validate(resolveFrom(nothing, "config"), process.cwd()), /declare "processes" instead/);
});

test("a static site cannot run a worker, and is told so", () => {
  // The one lane where refusing processes is correct: a static site is files in a
  // bucket. There is no container to run a bot in.
  const s = parseAppConfig(JSON.stringify({
    services: [{ language: "static", outputDir: ".", processes: { bot: { command: "python bot.py" } } }],
  }));

  assert.throws(() => validate(resolveFrom(s, "config"), process.cwd()), /static lane does not implement: processes/);
});

test("a pinned runtime gets the version it asked for", () => {
  // The hardcode at its most explicit, and now at its most gone. The platform
  // held one Python and one Node, and when a repo asked for anything else it
  // REFUSED THE DEPLOY: "widen requires-python in pyproject.toml, or wait for the
  // runner to move. Nothing in the code can fix this one." That was a platform
  // telling a business to change its software to fit the platform's one opinion.
  //
  // Then it routed around it — a pin demoted the app off the runner to a lane
  // that reads the repo's own version files. Now there is no runner to demote
  // from and no version the platform holds, so a pin is simply a version, and
  // every app builds an image for the one it named.
  assert.equal(laneFor({ runtime: "python3.12" }), "buildpack");
  assert.equal(laneFor({ runtime: "python3.14" }), "buildpack");
  // A committed Dockerfile still outranks everything: the author was explicit.
  assert.equal(laneFor({ runtime: "python3.12", dockerfile: "Dockerfile" }), "container");
});

test("the buildpack lane implements `runtime`, because the builder reads the file", () => {
  // This used to assert the other half too: `LANE_CONSUMES.runner` listed
  // `runtime` while the runner had exactly one version per language, so
  // `runtime: "python3.12"` was parsed, validated, printed back by `supersonic
  // check` and silently ignored — the precise defect assert-consumed exists to
  // catch, committed inside assert-consumed's own table. The lane that made that
  // possible is gone; the half that outlives it is that a lane which DOES honour
  // a field must say so.
  assert.doesNotThrow(() => assertConsumed({ ...service(), lane: "buildpack", declared: ["runtime"] }));
});

function service(): ResolvedService {
  return {
    name: "app", dir: ".", path: "/", lane: "buildpack", spaFallback: false,
    uses: [], processes: [], env: {}, buildEnv: {}, secrets: [], envNeeded: [],
    health: { path: "/", expect: 200 }, scale: DEFAULT_SCALE, declared: [],
  } as ResolvedService;
}

test("a repo file and a config field are independent signals, and either one pins", () => {
  // WAS a lane question: a `??` instead of `||` meant `resolveService` passing its
  // default `runtimePinned: false` silently overrode the config's own `runtime`
  // field, and a service declaring `python3.12` went straight back to the runner
  // that only has 3.14. Caught by the CLI suite rather than by this one, which is
  // the whole reason the CLI runs the control plane's compiled resolver.
  //
  // A pin no longer changes the lane, so the bug's route into `laneFor` is closed
  // by construction rather than by the operator. What is asserted here is exactly
  // that: neither signal, in either combination, can move an app off the lane its
  // own image puts it on.
  assert.equal(laneFor({ runtime: "python3.12", runtimePinned: false }), "buildpack");
  assert.equal(laneFor({ language: "python", runtimePinned: true }), "buildpack");
  assert.equal(laneFor({ runtime: "python3.14", runtimePinned: false }), "buildpack");
});
