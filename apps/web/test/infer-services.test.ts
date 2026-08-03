import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectorFromFiles, inferAppConfig, isDeployablePart, stackFromSpec,
  type DetectedStack,
} from "../lib/infer-services";
import { detect, serviceLanguage } from "../lib/detect";

/** Build a throwaway repo from a {path: contents} map. Directories are implied. */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "infer-services-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

/**
 * Stand-in for the deploy-agent detector.
 *
 * These are not invented shapes: each is the verbatim output of
 * `npm run detect -- <dir> --json` run against exactly this fixture on 1 Aug.
 * The detector is 90-95% accurate on a single-purpose directory — that measured
 * fact is what this module is built on, so the fake reproduces it rather than
 * asserting something more convenient.
 */
async function detector(dir: string): Promise<DetectedStack> {
  const vite: DetectedStack = {
    language: "JavaScript", framework: "Vite (SPA)",
    installCommand: "npm install", buildCommand: "npm run build", startCommand: "(static)",
    serve: { mode: "static", outputDir: "dist" },
  };
  const next: DetectedStack = {
    language: "JavaScript", framework: "Next.js",
    installCommand: "npm install", buildCommand: "npm run build", startCommand: "npm start",
    serve: { mode: "container" },
  };
  const fastapi: DetectedStack = {
    language: "Python", framework: "FastAPI",
    installCommand: "pip install --no-cache-dir -r requirements.txt", buildCommand: null,
    startCommand: "uvicorn main:app --host 0.0.0.0 --port 8000",
    serve: { mode: "container" },
  };
  const bare: DetectedStack = {
    language: "Static", framework: "Static site",
    installCommand: null, buildCommand: null, startCommand: "(nginx)",
    serve: { mode: "static", outputDir: "." },
  };
  if (/frontend|web$/.test(dir)) return vite;
  if (/apps\/web/.test(dir)) return next;
  if (/backend|api$/.test(dir)) return fastapi;
  return bare;
}

test("a repo with a frontend beside a backend infers one service for each", async () => {
  const dir = repo({
    "frontend/package.json": '{"dependencies":{"vite":"^5"},"scripts":{"build":"vite build"}}',
    "backend/requirements.txt": "fastapi\nuvicorn\n",
    "backend/app/main.py": "app = 1\n",
  });

  const cfg = (await inferAppConfig(dir, detector));

  assert.ok(cfg, "a two-part repo must infer a config");
  assert.deepEqual(cfg.services.map((s) => s.dir), ["frontend", "backend"]);
});

test("the part that serves a browser owns / and the API is routed under /api", async () => {
  const dir = repo({
    "frontend/package.json": '{"dependencies":{"vite":"^5"},"scripts":{"build":"vite build"}}',
    "backend/requirements.txt": "fastapi\n",
    "backend/app/main.py": "app = 1\n",
  });

  const cfg = (await inferAppConfig(dir, detector))!;

  assert.equal(cfg.services.find((s) => s.dir === "frontend")?.path, "/");
  assert.equal(cfg.services.find((s) => s.dir === "backend")?.path, "/api");
});

test("an inferred Python service starts on $PORT, never on a hardcoded one", async () => {
  // The runner refuses to guess a Python start command (entrypoint.sh: "FATAL: no
  // run command"), so inference has to supply one — and the detector's is
  // hardcoded to :8000 while Cloud Run only ever routes to $PORT.
  const dir = repo({
    "frontend/package.json": '{"dependencies":{"vite":"^5"}}',
    "backend/requirements.txt": "fastapi\n",
    "backend/app/main.py": "app = 1\n",
  });

  const start = (await inferAppConfig(dir, detector))!.services.find((s) => s.dir === "backend")!.start!;

  assert.match(start, /\$PORT/);
  assert.doesNotMatch(start, /8000/);
});

test("the ASGI module path follows where main.py actually is", async () => {
  // `uvicorn main:app` is right for backend/main.py and wrong for
  // backend/app/main.py — the detector says the first for both.
  const nested = repo({
    "frontend/package.json": '{"dependencies":{"vite":"^5"}}',
    "backend/requirements.txt": "fastapi\n",
    "backend/app/main.py": "app = 1\n",
  });
  const flat = repo({
    "frontend/package.json": '{"dependencies":{"vite":"^5"}}',
    "backend/requirements.txt": "fastapi\n",
    "backend/main.py": "app = 1\n",
  });

  assert.match((await inferAppConfig(nested, detector))!.services.find((s) => s.dir === "backend")!.start!, /app\.main:app/);
  assert.match((await inferAppConfig(flat, detector))!.services.find((s) => s.dir === "backend")!.start!, /(?<!\.)main:app/);
});

test("a single-part repo infers nothing, so today's path is untouched", async () => {
  // The no-regression guarantee: everything that deploys today must keep taking
  // exactly the route it takes today, which means inference has to decline.
  const dir = repo({
    "package.json": '{"dependencies":{"next":"^15"},"scripts":{"build":"next build"}}',
    "prisma/schema.prisma": 'datasource db { provider = "postgresql" }',
  });

  assert.equal((await inferAppConfig(dir, detector)), null);
});

test("a test harness beside the app is not a second service", async () => {
  // The false positive that matters most: almost every serious repo has an
  // `e2e/` or `tests/` with a package.json of its own. Reading one as a service
  // would take a single-app repo that deploys today and route half its traffic
  // to Playwright.
  const dir = repo({
    "package.json": '{"dependencies":{"next":"^15"},"scripts":{"build":"next build","start":"next start"}}',
    "e2e/package.json": '{"devDependencies":{"@playwright/test":"^1"},"scripts":{"test":"playwright test"}}',
  });

  assert.equal((await inferAppConfig(dir, detector)), null);
});

test("a package that neither builds nor starts is not a service", async () => {
  // Name lists only catch the conventions people happen to follow. A package
  // with no build and no start script has nothing to deploy whatever it is
  // called.
  const dir = repo({
    "package.json": '{"dependencies":{"next":"^15"},"scripts":{"build":"next build","start":"next start"}}',
    "fixtures/package.json": '{"scripts":{"lint":"eslint ."}}',
  });

  assert.equal((await inferAppConfig(dir, detector)), null);
});

test("a Python service installs from the manifest it actually has", async () => {
  // The detector answers `pip install -r requirements.txt` for every Python
  // project, whether or not there is one. The FastAPI template's backend is
  // pyproject.toml + uv.lock and has no requirements.txt at all, so that command
  // cannot succeed — and because a plan-supplied install overrides the runner's
  // own convention, inferring it REPLACES a correct default with a broken one.
  const dir = repo({
    "frontend/package.json": '{"dependencies":{"vite":"^5"},"scripts":{"build":"vite build"}}',
    "backend/pyproject.toml": '[project]\nname = "app"\n',
    "backend/app/main.py": "app = 1\n",
  });

  const api = (await inferAppConfig(dir, detector))!.services.find((s) => s.dir === "backend")!;

  assert.doesNotMatch(api.install!, /requirements\.txt/);
  assert.match(api.install!, /pip install .*\./);
});

test("a detector that fails on one part declines instead of failing the deploy", async () => {
  // Inference is an upgrade, never a prerequisite. A part we could not read is a
  // part we cannot deploy, and taking the whole deploy down over it would make
  // this strictly worse than not having it — the same rule build-config.ts
  // already states about the layer cache.
  const dir = repo({
    "frontend/package.json": '{"dependencies":{"vite":"^5"},"scripts":{"build":"vite build"}}',
    "backend/requirements.txt": "fastapi\n",
    "backend/app/main.py": "app = 1\n",
  });

  const broken = async (d: string): Promise<DetectedStack> => {
    if (/backend/.test(d)) throw new Error("detect exited 1");
    return detector(d);
  };

  assert.equal(await inferAppConfig(dir, broken), null);
});

test("a root Dockerfile is the author's own build, not ours to split", async () => {
  // The pipeline already holds this rule for the single-service path: "A project
  // that ships its own Dockerfile always takes a container lane, whatever the
  // detector concluded. The author was explicit." Splitting such a repo would
  // override an explicit instruction with an inference.
  const dir = repo({
    "Dockerfile": "FROM node:22\nCOPY . .\n",
    "frontend/package.json": '{"dependencies":{"vite":"^5"},"scripts":{"build":"vite build"}}',
    "backend/requirements.txt": "fastapi\n",
    "backend/app/main.py": "app = 1\n",
  });

  assert.equal(await inferAppConfig(dir, detector), null);
});

test("a workspace root is not a service of its own", async () => {
  // A root package.json declaring `workspaces` describes the repo, not an app.
  // Treating it as a third service deploys the monorepo root as an app.
  const dir = repo({
    "package.json": '{"private":true,"workspaces":["apps/*"]}',
    "apps/web/package.json": '{"dependencies":{"next":"^15"},"scripts":{"build":"next build","start":"next start"}}',
    "apps/api/requirements.txt": "fastapi\n",
    "apps/api/main.py": "app = 1\n",
  });

  const cfg = (await inferAppConfig(dir, detector))!;

  assert.deepEqual(cfg.services.map((s) => s.dir), ["apps/web", "apps/api"]);
});

/* ========================================================================== */
/* Driven by detect() — no subprocess, no model                               */
/* ========================================================================== */

test("the whole split can be inferred from files alone", async () => {
  // The same question the injected detector answers, answered by reading the
  // repository instead of spawning one process per part. `detect` is injected
  // rather than imported precisely so two implementations of the interface can
  // exist during the migration; this proves the deterministic one is one of them.
  const dir = repo({
    "frontend/package.json": '{"dependencies":{"vite":"^5"},"scripts":{"build":"vite build"}}',
    "frontend/pnpm-lock.yaml": "lockfileVersion: 9\n",
    "backend/requirements.txt": "fastapi\nuvicorn\n",
    "backend/app/main.py": "app = 1\n",
  });

  const cfg = (await inferAppConfig(dir, detectorFromFiles(dir)))!;

  assert.equal(cfg.services.length, 2);
  assert.equal(cfg.services[0].dir, "frontend");
  assert.equal(cfg.services[0].path, "/");
  assert.equal(cfg.services[0].language, "static");
  assert.equal(cfg.services[0].outputDir, "dist");
  // Per directory, not once over the root: the frontend's pnpm lockfile decides
  // the frontend's install, and the backend never sees it.
  assert.match(cfg.services[0].install!, /pnpm/);

  assert.equal(cfg.services[1].dir, "backend");
  assert.equal(cfg.services[1].path, "/api");
  assert.equal(cfg.services[1].language, "python");
  // The module is the one that exists, not the one the detector answers for
  // every Python project — uvicorn exits immediately on a module it cannot
  // import.
  assert.equal(cfg.services[1].start, "uvicorn app.main:app --host 0.0.0.0 --port $PORT");
});

test("a Next frontend keeps the primary slot, which the old regex decided by accident", async () => {
  // BROWSER_FACING matched `next\.?js` and `sveltekit` — the detector subprocess's
  // display names. detect() answers `next` and `svelte`, because those are the
  // tokens frameworkEnv routes on. With no match, findIndex returns -1,
  // Math.max(0, -1) picks index 0, and the first DECLARED directory owns `/` —
  // here the API, so the app's own address would have served JSON.
  const dir = repo({
    "api/requirements.txt": "fastapi\n",
    "api/main.py": "app = 1\n",
    "web/package.json": '{"dependencies":{"next":"^15"},"scripts":{"build":"next build","start":"next start"}}',
    "web/next.config.js": "module.exports = {}\n",
  });

  const cfg = (await inferAppConfig(dir, detectorFromFiles(dir)))!;
  assert.equal(cfg.services[0].dir, "web");
  assert.equal(cfg.services[0].path, "/");
  // …and it is a NODE service. `languageOf` matched only the detector's display
  // names, so detect()'s "node" became "other" — and laneFor reads "other" as
  // "not one of the runner's two languages", routing every inferred Node app off
  // the runner on a string comparison nobody would have thought to look at.
  assert.equal(cfg.services[0].language, "node");
});

test("a service with no version file of its own inherits the repository root's", () => {
  // A monorepo puts .nvmrc at the root and its app in frontend/, and the root
  // file is still the version the author means. The pipeline's own reader only
  // ever looks at the root; the CLI's drafting code looks at both. This is the
  // one that a per-service FROM is built from, so it has to be the second.
  const dir = repo({
    ".nvmrc": "20.11.0\n",
    "frontend/package.json": '{"dependencies":{"vite":"^5"},"scripts":{"build":"vite build"}}',
  });

  const inherited = detect(join(dir, "frontend"), { repoRoot: dir }, "frontend");
  const node = inherited.toolchains.find((t) => t.language === "node")!;
  assert.equal(node.version, "20.11.0");
  assert.match(node.versionFrom!, /\.nvmrc \(repo root\)/);

  // …and a directory that declares its own is not overridden by the root's.
  writeFileSync(join(dir, "frontend", ".nvmrc"), "22.1.0\n");
  const own = detect(join(dir, "frontend"), { repoRoot: dir }, "frontend");
  assert.equal(own.toolchains.find((t) => t.language === "node")!.version, "22.1.0");
});

test("stackFromSpec never hands on an empty framework or a missing start command", () => {
  // Both are optional on a BuildSpec and neither is optional downstream:
  // `startFor` dereferences startCommand unconditionally and runs OUTSIDE the
  // try/catch that makes inference safe, and `framework` is the sole input to
  // primary-service selection.
  const bare = stackFromSpec({ toolchains: [], language: "static", needs: [], confidence: "guessed" });
  assert.equal(typeof bare.startCommand, "string");
  assert.ok(bare.framework.length > 0);

  const asStatic = stackFromSpec({
    toolchains: [], language: "static", outputDir: "dist", needs: [], confidence: "certain",
  });
  assert.deepEqual(asStatic.serve, { mode: "static", outputDir: "dist" });
  assert.match(asStatic.framework, /static/i);

  // The engine survives the trip even though ServiceConfig has nowhere to put
  // it: Part 3 needs it to decide the proxyWait prefix, and `needsDB: true`
  // alone would provision Postgres for a MySQL app.
  const withDb = stackFromSpec({
    toolchains: [], language: "node", command: "node i.js", needs: [], confidence: "certain",
    database: { engine: "mysql", via: "Drizzle" },
  });
  assert.deepEqual(withDb.database, { engine: "mysql", via: "Drizzle" });
});

test("isDeployablePart does NOT go through detect(), because it cannot", () => {
  // detect() has no way to answer "this directory is not an app": BuildSpec has
  // no negative, and pointed at e2e/ it returns a perfectly valid answer. The
  // question stays where its two tables live.
  const dir = repo({ "e2e/package.json": '{"scripts":{"build":"tsc"}}' });
  assert.equal(isDeployablePart(join(dir, "e2e"), "e2e"), false);
  assert.notEqual(detect(join(dir, "e2e"), {}, "e2e").toolchains.length, 0);
});

test("the seven-language vocabulary maps onto the four ServiceConfig allows", () => {
  assert.equal(serviceLanguage("node"), "node");
  assert.equal(serviceLanguage("TypeScript"), "node");     // the detector's spelling
  assert.equal(serviceLanguage("JavaScript"), "node");
  assert.equal(serviceLanguage("python"), "python");
  assert.equal(serviceLanguage("Python"), "python");
  // The five that collapse are not a loss: laneFor reads "other" as "not the
  // runner's two languages", which routes to the container lane — where a
  // generated Dockerfile is exactly what builds them.
  for (const l of ["go", "rust", "ruby", "php", "java"]) assert.equal(serviceLanguage(l), "other", l);
  assert.equal(serviceLanguage("node", true), "static");
});

test("a workspace whose only app is nested is pointed at, not read from its root", () => {
  // The Excalidraw shape, and the failure is a wrong SUCCESS.
  //
  // `deployableParts` correctly drops the workspace root — it declares
  // `workspaces`, so the real app lives elsewhere — leaving one part, which was
  // below the two-part threshold for a SPLIT. Returning null then handed the
  // deploy back to a root `detect()`, which reads the workspace root as the app.
  // A workspace root's `scripts.start` is a delegation to the member
  // (`yarn --cwd excalidraw-app start`), which is a DEV SERVER: the repo built,
  // deployed, bound port 5173 and failed its health check with "didn't start on
  // $PORT" — at confidence "certain", because every individual reading was
  // correct about the wrong directory.
  //
  // There is nothing to split here. There is something to aim at.
  const dir = repo({
    "package.json": JSON.stringify({
      private: true, workspaces: ["excalidraw-app", "packages/*"],
      scripts: { start: "yarn --cwd excalidraw-app start", build: "yarn --cwd excalidraw-app build" },
    }),
    "yarn.lock": "# yarn lockfile v1\n",
    "excalidraw-app/package.json": JSON.stringify({
      scripts: { start: "vite", build: "vite build" },
      dependencies: { react: "18.2.0" }, devDependencies: { vite: "5.0.12" },
    }),
    "excalidraw-app/vite.config.mts": "export default {}\n",
  });

  return inferAppConfig(dir, detectorFromFiles(dir)).then((cfg) => {
    assert.ok(cfg, "a workspace with one app is still an app");
    assert.equal(cfg!.services.length, 1, "one app is one service — no sibling, no path routing");
    const only = cfg!.services[0];
    assert.equal(only.dir, "excalidraw-app");
    assert.equal(only.path, "/");
    // A Vite SPA is a directory of files, which is the lane it deploys on today.
    // The dev server must not have survived into the answer.
    assert.equal(only.language, "static");
    assert.notEqual(only.start, "yarn start");
  });
});

test("a plain repo with one app is still declined, because there is nothing to aim at", () => {
  // The narrowing matters as much as the widening: `workspaces` is the signal,
  // not "there is a subdirectory". Without it the root may well be the app —
  // a root Express API beside a `frontend/` is the shape `deployableParts`
  // already keeps the root for — and declining hands the repo to the path it
  // takes today, which is the rule this module never breaks.
  const dir = repo({
    "package.json": JSON.stringify({ dependencies: { next: "^15" }, scripts: { build: "next build", start: "next start" } }),
  });
  return inferAppConfig(dir, detectorFromFiles(dir)).then((cfg) => assert.equal(cfg, null));
});

test("an inferred service carries the migration its directory implies", () => {
  // `DetectedStack` had nowhere to put a release command, so `detect()` found
  // `alembic upgrade head` for a backend and `serviceFor` dropped it — and the
  // service deployed GREEN against an unmigrated schema. That is the worst
  // failure shape the platform has, and it was reachable only through inference,
  // which is the path a config-less repo takes by definition.
  const dir = repo({
    "frontend/package.json": JSON.stringify({ dependencies: { vite: "^5" }, scripts: { build: "vite build" } }),
    "backend/requirements.txt": "fastapi\nuvicorn\nalembic\nsqlalchemy\npsycopg2-binary\n",
    "backend/main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
    "backend/alembic.ini": "[alembic]\n",
  });

  return inferAppConfig(dir, detectorFromFiles(dir)).then((cfg) => {
    const api = cfg!.services.find((s) => s.dir === "backend")!;
    assert.equal(api.release, "alembic upgrade head");
    // And the database that migration needs was inferred alongside it.
    assert.equal(api.needsDB, true);
  });
});

test("a lockfile-pinned python service is not downgraded to an unpinned resolve", () => {
  // `pythonInstall` knew two manifests — `requirements.txt`, else
  // `pip install .`. The FastAPI template's backend is `pyproject.toml` +
  // `uv.lock`, so it fell to the second row: an install pinned to a resolved
  // dependency graph replaced by an unpinned resolve from PyPI, applied to
  // precisely the repositories that pinned most carefully.
  const dir = repo({
    "frontend/package.json": JSON.stringify({ dependencies: { vite: "^5" }, scripts: { build: "vite build" } }),
    "backend/pyproject.toml": '[project]\nname = "app"\ndependencies = ["fastapi"]\n',
    "backend/uv.lock": "version = 1\n",
    "backend/app/main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
  });

  return inferAppConfig(dir, detectorFromFiles(dir)).then((cfg) => {
    const api = cfg!.services.find((s) => s.dir === "backend")!;
    assert.match(api.install!, /uv sync --frozen/);
    // Both halves are present: a ServiceConfig has one field where a toolchain
    // has two, and an environment missing the project install is incomplete.
    assert.match(api.install!, /--no-install-project.*&&.*uv sync --frozen --no-dev$/);
  });
});
