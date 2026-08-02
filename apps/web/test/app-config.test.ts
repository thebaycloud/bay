import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAppConfig, planFromConfig, inDir, ConfigError, primaryService, extraServices, servicePath, releaseCommand } from "../lib/app-config";

test("a plan says where it came from, and does not name a file that does not exist", () => {
  // `Plan ready: supersonic.json (frontend)` was printed on a deploy of a repo
  // that has no supersonic.json — the config had been inferred. Naming a file
  // the user could then go and look for, and not find, is the same class of
  // defect as a confidence number nothing reads.
  const cfg = parseAppConfig(JSON.stringify({ services: [{ name: "frontend", dir: "frontend", language: "static" }] }));

  assert.match(planFromConfig(cfg).reason!, /^supersonic\.json/);
  assert.equal(planFromConfig(cfg, undefined, "inferred from the repo").reason, "inferred from the repo (frontend)");
});

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

test("processes are parsed, and a sibling declaring them is refused", () => {
  // The Procfile-shaped app this schema exists for: a bot with no HTTP, a cron,
  // and a release — none of which `start` can express.
  const cfg = parseAppConfig(JSON.stringify({
    services: [{
      name: "app",
      processes: {
        web: { command: "gunicorn config.wsgi --bind 0.0.0.0:$PORT", visibility: "internal" },
        bot: { command: "python bot.py", instances: 3 },
        nightly: { command: "python manage.py digest", schedule: "0 3 * * *" },
      },
    }],
  }));

  assert.deepEqual(Object.keys(cfg.services[0].processes!), ["web", "bot", "nightly"]);
  assert.equal(cfg.services[0].processes!.bot.instances, 3);
  // Dropped rather than carried as undefined, so `declaredFields` in
  // lib/processes.ts cannot read an unset field as authored.
  assert.equal("memory" in cfg.services[0].processes!.bot, false);

  // A sibling's workers would need the sibling's own image and env, which
  // `deploySibling` does not build in a shape the process planner can reach. So
  // it is refused, not accepted and skipped.
  assert.throws(() => parseAppConfig(JSON.stringify({
    services: [
      { name: "web", path: "/", start: "npm start" },
      { name: "api", path: "/api", start: "uvicorn app:app", processes: { bot: { command: "python bot.py" } } },
    ],
  })), /"processes" on a sibling service is not deployed yet/);
});

test("a malformed process is named at parse time, not discovered downstream", () => {
  const bad = (processes: unknown) =>
    () => parseAppConfig(JSON.stringify({ services: [{ processes }] }));

  assert.throws(bad("web"), /must be an object of NAME/);
  assert.throws(bad([{ command: "x" }]), /must be an object of NAME/);
  assert.throws(bad({ "my web": { command: "x" } }), /not a valid process name/);
  assert.throws(bad({ web: "npm start" }), /services\[0\]\.processes\.web must be an object/);
  assert.throws(bad({ web: { command: 3 } }), /services\[0\]\.processes\.web\.command must be a string/);
  assert.throws(bad({ web: { command: "x", cpu: "1" } }), /services\[0\]\.processes\.web\.cpu must be a number/);
  assert.throws(bad({ web: { command: "x", visibility: "private" } }), /must be "public" or "internal"/);
  assert.throws(bad({ web: { command: "x", kind: "daemon" } }), /kind must be one of web, worker, cron, release/);
});

test("a service with no processes is untouched by any of this", () => {
  // The whole of step 1 is additive: every config that deploys today parses
  // exactly as it did, and `processes` is undefined rather than an empty object —
  // which is what keeps `declaredFields` from reading it as authored.
  const cfg = parseAppConfig(JSON.stringify({ services: [{ language: "node", start: "npm start" }] }));

  assert.equal(cfg.services[0].processes, undefined);
  assert.equal(cfg.services[0].start, "npm start");
});

test("a cron's timezone survives the parser", () => {
  // It did not. `timezone` was added to ProcessConfig and to TaskProcess and NOT
  // to processConfigs, so `supersonic check` printed "0 3 * * * UTC" for a config
  // that said Asia/Almaty — a field parsed nowhere and dropped silently, which is
  // the defect this schema exists to end, committed while building the fix for it.
  const cfg = parseAppConfig(JSON.stringify({
    services: [{ processes: { nightly: { command: "x", schedule: "0 3 * * *", timezone: "Asia/Almaty" } } }],
  }));

  assert.equal(cfg.services[0].processes!.nightly.timezone, "Asia/Almaty");
});

test("a release declared as a process IS the release phase, not a second one", () => {
  // Two fields with one meaning and only one reader is the defect. The check
  // output made it visible: "release — nothing runs before traffic" printed
  // directly above "release  python manage.py migrate".
  const cfg = parseAppConfig(JSON.stringify({
    services: [{ processes: { web: { command: "npm start" }, release: { command: "npm run migrate" } } }],
  }));

  assert.equal(releaseCommand(cfg.services[0]), "npm run migrate");

  // And the top-level field still wins, so a config carrying both keeps meaning
  // exactly what it meant.
  const both = parseAppConfig(JSON.stringify({
    services: [{ release: "npm run m1", processes: { release: { command: "npm run m2" } } }],
  }));
  assert.equal(releaseCommand(both.services[0]), "npm run m1");
});
