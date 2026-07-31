import { test } from "node:test";
import assert from "node:assert/strict";
import { commandBinaries, requirementNames, checkPlanDeps } from "../lib/plan-deps";

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
