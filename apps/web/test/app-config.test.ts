import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAppConfig, planFromConfig, inDir, ConfigError, primaryService, extraServices, servicePath } from "../lib/app-config";

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
  assert.equal(plan.install, "(cd backend && pip install -r requirements.txt)");
  assert.equal(plan.run, "(cd backend && uvicorn app.main:app --host 0.0.0.0 --port $PORT)");
  assert.deepEqual(plan.preRun, ["(cd backend && alembic upgrade head)"]);
  assert.equal(plan.needsDB, true);
  assert.deepEqual(plan.envNeeded, ["SECRET_KEY"]);
  assert.match(plan.reason!, /supersonic\.json/);
});

test("commands run from the repo root, so a subdirectory has to be entered", () => {
  assert.equal(inDir("npm ci", "."), "npm ci");
  assert.equal(inDir("npm ci", "frontend"), "(cd frontend && npm ci)");
  // A SUBSHELL, because the static lane joins install and build into one shell
  // with `&&`: without the parentheses the second command inherits the first's
  // directory and `cd frontend` fails looking for frontend/frontend.
  const joined = [inDir("npm ci", "frontend"), inDir("npm run build", "frontend")].join(" && ");
  assert.equal(joined, "(cd frontend && npm ci) && (cd frontend && npm run build)");
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
  assert.equal(plan.build, "(cd frontend && npm run build)");
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

test("the service on / is the primary, whatever order they are declared in", () => {
  // The API is listed first and the frontend second; the frontend still owns the
  // app's bare URL, because it says so.
  const cfg = parseAppConfig(JSON.stringify({
    services: [
      { name: "api", dir: "backend", language: "python", path: "/api", start: "uvicorn app.main:app --port $PORT" },
      { name: "web", dir: "frontend", language: "node", path: "/", start: "next start -p $PORT" },
    ],
  }));
  assert.equal(primaryService(cfg).name, "web");
  assert.deepEqual(extraServices(cfg).map((s) => s.name), ["api"]);
  assert.equal(servicePath(extraServices(cfg)[0]), "/api");
  // Each service plans independently, from its own directory.
  assert.equal(planFromConfig(cfg, extraServices(cfg)[0]).run, "(cd backend && uvicorn app.main:app --port $PORT)");
  assert.equal(planFromConfig(cfg).run, "(cd frontend && next start -p $PORT)");
});

test("with no explicit path the first service is primary", () => {
  const cfg = parseAppConfig(JSON.stringify({ services: [{ name: "a", start: "x" }, { name: "b", path: "/b", start: "y" }] }));
  assert.equal(primaryService(cfg).name, "a");
  assert.deepEqual(extraServices(cfg).map((s) => s.name), ["b"]);
});

test("two services cannot claim the same path", () => {
  // One of them would silently never receive a request, which is
  // indistinguishable from that service being broken.
  assert.throws(() => parseAppConfig(JSON.stringify({
    services: [{ name: "a", path: "/api", start: "x" }, { name: "b", path: "/api/", start: "y" }],
  })), /both serve \/api/);
  assert.throws(() => parseAppConfig(JSON.stringify({ services: [{ path: "api", start: "x" }] })), /must start with/);
});
