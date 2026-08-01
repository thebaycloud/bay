import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inferAppConfig, type DetectedStack } from "../lib/infer-services";

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
