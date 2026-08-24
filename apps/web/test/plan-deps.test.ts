import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandBinaries, requirementNames, checkPlanDeps, runtimeMismatch,
  assertRuntimeSupported, RUNTIME_VERSIONS, RUNTIME_UNSUPPORTED,
} from "../lib/plan-deps";
import { detectStack } from "../../../packages/detector/src/index";

/** A file in the repo, read relative to this test rather than to the cwd. */
function repoFile(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

test("the programs a run command invokes", () => {
  // The shapes the planner actually emits, one per stack it has produced.
  assert.deepEqual(commandBinaries("gunicorn app:app --bind 0.0.0.0:$PORT"), ["gunicorn"]);
  assert.deepEqual(commandBinaries("uvicorn main:app --host 0.0.0.0 --port $PORT"), ["uvicorn"]);
  assert.deepEqual(commandBinaries("node server.js"), ["node"]);
  assert.deepEqual(commandBinaries("prisma migrate deploy && node dist/api/main.js"), ["prisma", "node"]);
  assert.deepEqual(commandBinaries("npx --no-install next start -p $PORT"), ["next"]);

  // `python -m X` names X — the same server, spelled the other way.
  assert.deepEqual(commandBinaries("python -m uvicorn main:app --port $PORT"), ["uvicorn"]);
  assert.deepEqual(commandBinaries("python manage.py migrate"), ["python"]);

  // Environment prefixes are not the program.
  assert.deepEqual(commandBinaries("NODE_ENV=production PORT=$PORT node index.js"), ["node"]);

  // A command hidden inside `sh -c` is a quoted string; guessing at it is how a
  // check like this starts failing working deploys.
  assert.deepEqual(commandBinaries('sh -c "gunicorn app:app"'), []);

  assert.deepEqual(commandBinaries(""), []);
  assert.deepEqual(commandBinaries("   "), []);
});

test("requirements.txt is read the way pip compares names", () => {
  const names = requirementNames([
    "Flask==3.0.0",
    "uvicorn[standard]>=0.30",
    "python_dateutil ~= 2.8",
    "psycopg2-binary; python_version < '3.12'",
    "# a comment",
    "-r dev-requirements.txt",
    "--index-url https://example.test/simple",
    "",
  ].join("\n"));

  assert.ok(names.has("flask"), "case-insensitive");
  assert.ok(names.has("uvicorn"), "extras stripped");
  assert.ok(names.has("python-dateutil"), "underscores normalise to dashes");
  assert.ok(names.has("psycopg2-binary"), "environment markers stripped");
  assert.equal(names.has("#"), false);
  assert.equal(names.size, 4, "flags and comments are not packages");
});

test("the Flask/gunicorn miss is caught and fixed, not merely reported", () => {
  // Verbatim the case that failed the stress test: a correct production command
  // for a project that never installed the server it names.
  const check = checkPlanDeps(
    { run: "gunicorn app:app --bind 0.0.0.0:$PORT" },
    { language: "python", requirements: "Flask==3.0.0\npsycopg2-binary\n" },
  );
  assert.deepEqual(check.install, ["gunicorn"]);
  assert.deepEqual(check.unknown, []);
});

test("a server the project already declares is left alone", () => {
  const check = checkPlanDeps(
    { run: "uvicorn main:app --host 0.0.0.0 --port $PORT" },
    { language: "python", requirements: "fastapi\nuvicorn[standard]==0.30.1\n" },
  );
  assert.deepEqual(check.install, [], "already installed — nothing to add");
  assert.deepEqual(check.unknown, []);
});

test("without a requirements.txt nothing is installed, because nothing is certain", () => {
  // A pyproject-only project: prepare.sh installs from pyproject, and CREATING a
  // requirements.txt would make it install from that instead — dropping every real
  // dependency. Being unsure has to mean saying so, not acting.
  const check = checkPlanDeps(
    { run: "gunicorn app:app --bind 0.0.0.0:$PORT" },
    { language: "python", requirements: null },
  );
  assert.deepEqual(check.install, []);
  assert.deepEqual(check.unknown, ["gunicorn"]);
});

test("an unrecognised python program is reported, never installed", () => {
  // Installing a package whose name we inferred from a binary is a worse failure
  // than a warning: it is an unreviewed package from the public index.
  const check = checkPlanDeps(
    { run: "some-inhouse-server --port $PORT" },
    { language: "python", requirements: "flask\n" },
  );
  assert.deepEqual(check.install, []);
  assert.deepEqual(check.unknown, ["some-inhouse-server"]);
});

test("Node findings never become actions", () => {
  // package.json is not the whole story: node_modules/.bin is filled by transitive
  // deps and workspace packages, so `nest` (from @nestjs/cli) and a monorepo's
  // tools are absent from the root manifest and present at runtime. A check that
  // acted on this would break deploys that work today.
  const check = checkPlanDeps(
    { run: "nest start", preRun: ["prisma migrate deploy"] },
    { language: "node", packageJson: { dependencies: { "@nestjs/core": "^10" } } },
  );
  assert.deepEqual(check.install, [], "node is warn-only, always");
  assert.deepEqual(check.unknown.sort(), ["nest", "prisma"]);

  // And a binary the manifest does declare is not even worth mentioning.
  const clean = checkPlanDeps(
    { run: "next start -p $PORT" },
    { language: "node", packageJson: { dependencies: { next: "^15" } } },
  );
  assert.deepEqual(clean.unknown, []);
});

test("paths and base-image programs are not treated as missing packages", () => {
  const check = checkPlanDeps(
    { run: "node dist/main.js", preRun: ["./scripts/migrate.sh", "npm run seed"] },
    { language: "node", packageJson: {} },
  );
  assert.deepEqual(check.unknown, [], "node and npm ship in the image; ./scripts/… is a path");
});

test("an app asking for a runtime we do not have is told so plainly", () => {
  // The failure without this is a pip line forty lines into a build log —
  // "Package 'app' requires a different Python: 3.12.13 not in '<4.0,>=3.14'" —
  // which reads as the app being broken rather than the platform being behind.
  // Verbatim from fastapi/full-stack-fastapi-template.
  assert.match(
    runtimeMismatch({ pyproject: 'requires-python = ">=3.15,<4.0"\n' }) ?? "",
    /needs Python >=3\.15.*runner has 3\.14/,
  );
  assert.equal(runtimeMismatch({ pyproject: 'requires-python = ">=3.14,<4.0"\n' }), null, "exactly what we have is fine");
  assert.equal(runtimeMismatch({ pyproject: 'requires-python = ">=3.10"\n' }), null, "older is fine");
  assert.equal(runtimeMismatch({ pyproject: null }), null);

  assert.match(runtimeMismatch({ packageJson: { engines: { node: ">=26" } } }) ?? "", /needs Node >=26.*runner has 24/);
  assert.equal(runtimeMismatch({ packageJson: { engines: { node: ">=20" } } }), null);
  // A range with no lower bound says nothing about what we must provide.
  assert.equal(runtimeMismatch({ packageJson: { engines: { node: "*" } } }), null);
});

test("the sentence names both versions and the file to change", () => {
  // Whoever reads this has exactly two moves and only one of them is theirs. The
  // old wording ("this is a platform limit, not your app") named neither, so the
  // useful half — which line to edit — was left for the repair agent to guess at.
  const py = runtimeMismatch({ pyproject: 'requires-python = ">=3.15,<4.0"\n' }) ?? "";
  assert.match(py, />=3\.15/, "the version declared");
  assert.match(py, /3\.14/, "the version we have");
  assert.match(py, /requires-python in pyproject\.toml/, "the line to edit");

  const node = runtimeMismatch({ packageJson: { engines: { node: ">=26" } } }) ?? "";
  assert.match(node, />=26/);
  assert.match(node, /24/);
  assert.match(node, /engines\.node in package\.json/);
});

test("a runtime the platform does not have stops the deploy instead of logging at it", () => {
  // The old path logged the mismatch, built anyway, failed at pip, and handed the
  // result to the repair agent — which then rediscovered, from build output, a
  // sentence we had already written before the build started. The marker is what
  // keeps it out of the repair loop: deploy-pipeline.ts routes errors carrying one
  // of these straight to the user, as it does for IAM and for an ambiguous stack.
  assert.throws(
    () => assertRuntimeSupported({ pyproject: 'requires-python = ">=3.15,<4.0"\n' }),
    (e: Error) => e.message.startsWith(`${RUNTIME_UNSUPPORTED}:`) && /needs Python >=3\.15/.test(e.message),
  );
  assert.throws(
    () => assertRuntimeSupported({ packageJson: { engines: { node: ">=26" } } }),
    (e: Error) => e.message.startsWith(`${RUNTIME_UNSUPPORTED}:`),
  );
  // And an app the platform can actually serve is not stopped by the gate.
  assertRuntimeSupported({ pyproject: 'requires-python = ">=3.10"\n', packageJson: { engines: { node: ">=20" } } });
  assertRuntimeSupported({});
});

test("RUNTIME_VERSIONS is what the runner Dockerfiles say", () => {
  // The four statements of these numbers had already drifted — the deploy-agent
  // said python:3.12 while the runner shipped 3.14, which is how a repo declaring
  // requires-python >=3.14 got built on the wrong interpreter. This is the pin:
  // the Dockerfiles are the source of truth, and moving one without moving the
  // constant fails here rather than in somebody's build log.
  //
  // Read here rather than at module load because infra/runner is NOT in the
  // deployed control-plane image (the root Dockerfile copies apps/web and
  // packages/detector, nothing else) — parsing at import would pass on every
  // laptop and throw in production.
  const from = (df: string) => repoFile(df).match(/^FROM\s+(\S+)/m)?.[1] ?? "";
  assert.equal(from("infra/runner/python/Dockerfile"), `python:${RUNTIME_VERSIONS.python}-slim`);
  assert.equal(from("infra/runner/node/Dockerfile"), `node:${RUNTIME_VERSIONS.node}-slim`);
});

test("the deploy-agent builds Python apps on the version the platform has", () => {
  // The fourth statement of the same number, and the one that was wrong: `runtime`
  // is what pythonDockerfile() emits as `FROM python:…-slim`, so `python:3.12`
  // here meant a 3.14 app was installed under 3.12 and blamed for it.
  const dir = mkdtempSync(join(tmpdir(), "runtime-agree-"));
  writeFileSync(join(dir, "requirements.txt"), "flask\n");
  assert.equal(detectStack(dir).runtime, `python:${RUNTIME_VERSIONS.python}`);
});
