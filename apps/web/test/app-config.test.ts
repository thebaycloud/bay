import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAppConfig, planFromConfig, inDir, ConfigError } from "../lib/app-config";

const polyglot = JSON.stringify({
  services: [{
    name: "api",
    dir: "backend",
    language: "python",
    install: "pip install -r requirements.txt",
    preDeploy: "alembic upgrade head",
    start: "uvicorn app.main:app --host 0.0.0.0 --port $PORT",
    needsDB: true,
    env: ["SECRET_KEY"],
  }],
});

test("a config becomes the same plan shape a planner would produce", () => {
  // Reusing DeployPlan is the point: a configured deploy takes the identical path
  // through the runner lane, the dependency check and the static lane, so the two
  // cannot drift into differently-behaved code paths.
  const plan = planFromConfig(parseAppConfig(polyglot));
  assert.equal(plan.language, "python");
  assert.equal(plan.install, "cd backend && pip install -r requirements.txt");
  assert.equal(plan.run, "cd backend && uvicorn app.main:app --host 0.0.0.0 --port $PORT");
  assert.deepEqual(plan.preRun, ["cd backend && alembic upgrade head"]);
  assert.equal(plan.needsDB, true);
  assert.deepEqual(plan.envNeeded, ["SECRET_KEY"]);
  assert.match(plan.reason!, /supersonic\.json/);
});

test("commands run from the repo root, so a subdirectory has to be entered", () => {
  assert.equal(inDir("npm ci", "."), "npm ci");
  assert.equal(inDir("npm ci", "frontend"), "cd frontend && npm ci");
  // Present-but-empty means "there is deliberately no step here" and must stay
  // distinguishable from absent — the same distinction that, got wrong elsewhere,
  // turned an empty outputDir into a `dist` that did not exist.
  assert.equal(inDir("", "frontend"), "");
  assert.equal(inDir(undefined, "frontend"), undefined);
});

test("a static service's output directory is relative to its own directory", () => {
  const plan = planFromConfig(parseAppConfig(JSON.stringify({
    services: [{ dir: "frontend", language: "static", build: "npm run build", outputDir: "dist" }],
  })));
  assert.equal(plan.static, true);
  assert.equal(plan.outputDir, "frontend/dist");
  assert.equal(plan.build, "cd frontend && npm run build");
});

test("a config that is present and wrong fails loudly", () => {
  // Falling back to the planner on a malformed file would make a typo look like
  // the platform silently ignoring what the user asked for.
  assert.throws(() => parseAppConfig("{oops"), ConfigError);
  assert.throws(() => parseAppConfig("[]"), ConfigError);
  assert.throws(() => parseAppConfig('{"services":[]}'), ConfigError);
  assert.throws(() => parseAppConfig('{"services":[{"language":"rust"}]}'), /language must be one of/);
  assert.throws(() => parseAppConfig('{"services":[{"install":5}]}'), /must be a string/);
  assert.throws(() => parseAppConfig('{"services":[{"env":"API_KEY"}]}'), /array of variable NAMES/);
});

test("a dir cannot climb out of the repository", () => {
  // These land in a shell command and a tar path.
  assert.throws(() => parseAppConfig('{"services":[{"dir":"../../etc"}]}'), /inside the repository/);
  assert.throws(() => parseAppConfig('{"services":[{"dir":"/etc"}]}'), /inside the repository/);
  assert.equal(parseAppConfig('{"services":[{"dir":"./api/"}]}').services[0].dir, "api");
  assert.equal(parseAppConfig('{"services":[{}]}').services[0].dir, ".");
});

test("more than one service is refused, not silently half-deployed", () => {
  const two = JSON.stringify({ services: [{ start: "a" }, { start: "b" }] });
  assert.throws(() => planFromConfig(parseAppConfig(two)), /only one is supported/);
  // But it PARSES — the array is the schema going forward, so files written today
  // stay valid when the second service lands.
  assert.equal(parseAppConfig(two).services.length, 2);
});
