import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveProcess, resolveProcesses, deriveKind, mergeProcfile, assertEmittable,
  unemittable, PRIMITIVE, ProcessError,
  DEFAULT_INSTANCES, DEFAULT_TASK_TIMEOUT, DEFAULT_RETRIES,
  type WebProcess, type WorkerProcess, type TaskProcess,
} from "../lib/processes";
import { DEFAULT_SCALE } from "../lib/lanes";

test("the three shapes the platform exists for are all expressible", () => {
  // A Telegram bot: a worker with no HTTP at all. Under the `start`-only schema
  // this could not be said, and faking a listener does not work either — a Cloud
  // Run SERVICE will not serve a revision until the startup probe reaches $PORT.
  const bot = resolveProcesses({ bot: { command: "python bot.py" } });
  assert.deepEqual(bot.map((p) => [p.name, p.kind]), [["bot", "worker"]]);
  assert.equal(PRIMITIVE[bot[0].kind], "worker-pool");

  // An agent server: web + worker.
  const agent = resolveProcesses({
    web: { command: "uvicorn app:app --host 0.0.0.0 --port $PORT" },
    queue: { command: "python -m worker" },
  });
  assert.deepEqual(agent.map((p) => p.kind), ["web", "worker"]);

  // A CRM: web + cron + release.
  const crm = resolveProcesses({
    web: { command: "gunicorn config.wsgi --bind 0.0.0.0:$PORT" },
    release: { command: "python manage.py migrate --noinput" },
    nightly: { command: "python manage.py digest", schedule: "0 3 * * *" },
  });
  assert.deepEqual(
    crm.map((p) => [p.name, p.kind, PRIMITIVE[p.kind]]),
    [["web", "web", "service"], ["release", "release", "job"], ["nightly", "cron", "job"]],
  );
});

test("kind comes from name and shape, with only two reserved names", () => {
  assert.equal(deriveKind("web", {}), "web");
  assert.equal(deriveKind("release", {}), "release");
  // Anything else is a worker and keeps its own name. `nightly`, `digest` and
  // `cleanup` are all equally plausible cron names, so a name list would be the
  // same mistake as enumerating languages — the SCHEDULE is what makes a cron.
  assert.equal(deriveKind("bot", {}), "worker");
  assert.equal(deriveKind("consumer", {}), "worker");
  assert.equal(deriveKind("nightly", { schedule: "0 3 * * *" }), "cron");
  // An explicit kind still wins, for the app whose worker happens to be called web.
  assert.equal(deriveKind("web", { kind: "worker" }), "worker");
});

test("web is unchanged from today's Scale, field for field", () => {
  const web = resolveProcess("web", { command: "npm start" }) as WebProcess;

  assert.deepEqual(web.scale, DEFAULT_SCALE);
  assert.equal(web.visibility, "public");
  assert.deepEqual(web.health, { path: "/", expect: 200 });
});

test("a partial scale keeps the 2Gi floor instead of overwriting it with undefined", () => {
  // The bug withScale exists for: spreading a partial over the defaults replaces
  // a default with `undefined`, because spreading does not skip a key whose value
  // is undefined. `--concurrency undefined` reached gcloud once already.
  const web = resolveProcess("web", { command: "npm start", maxInstances: 3 }) as WebProcess;

  assert.equal(web.scale.maxInstances, 3);
  assert.equal(web.scale.memory, DEFAULT_SCALE.memory);
  assert.equal(web.scale.concurrency, DEFAULT_SCALE.concurrency);
  assert.ok(Object.values(web.scale).every((v) => v !== undefined));
});

test("a worker may not declare what a worker pool cannot emit", () => {
  // Verified against `gcloud beta run worker-pools deploy --help` on SDK 539.0.0:
  // it takes --cpu, --memory and --scaling, and takes NO --concurrency,
  // --timeout, --max-instances or --cpu-boost. A shared Scale type would have
  // accepted all four and dropped them, which is the declared-but-ignored defect
  // this module exists to avoid.
  for (const field of ["concurrency", "timeout", "maxInstances", "cpuBoost", "health", "visibility"] as const) {
    assert.throws(
      () => assertEmittable("bot", "worker", { command: "python bot.py", [field]: 1 }),
      (e: Error) => {
        assert.ok(e instanceof ProcessError);
        assert.match(e.message, new RegExp(field));
        // The message names the primitive, because "not supported" sends someone
        // reading the schema instead of the platform's own limits.
        assert.match(e.message, /worker-pool/);
        return true;
      },
      `a worker was allowed to declare ${field}`,
    );
  }
});

test("a web process may not declare worker or cron fields", () => {
  assert.throws(() => assertEmittable("web", "web", { command: "npm start", instances: 3 }), /instances/);
  assert.throws(() => assertEmittable("web", "web", { command: "npm start", schedule: "* * * * *" }), /schedule/);
});

test("instances is a fixed count because --scaling cannot express a range", () => {
  const w = resolveProcess("bot", { command: "python bot.py", instances: 3 }) as WorkerProcess;
  assert.equal(w.instances, 3);

  assert.equal((resolveProcess("bot", { command: "x" }) as WorkerProcess).instances, DEFAULT_INSTANCES);
  // Zero is not a default anybody wants by accident: it is a worker that does not run.
  assert.throws(() => resolveProcess("bot", { command: "x", instances: 0 }), /1 or more/);
  assert.throws(() => resolveProcess("bot", { command: "x", instances: 1.5 }), /whole number/);
});

test("a cron without a schedule is refused, since the schedule is what makes it one", () => {
  assert.throws(() => resolveProcess("nightly", { command: "x", kind: "cron" }), /needs a "schedule"/);

  const c = resolveProcess("nightly", { command: "x", schedule: "0 3 * * *" }) as TaskProcess;
  assert.equal(c.schedule, "0 3 * * *");
  assert.equal(c.taskTimeout, DEFAULT_TASK_TIMEOUT);
  // No retries by default, carried over from releaseJobArgs: a job that failed
  // half way is not improved by running again against what it half-changed, and
  // the retries bury the first failure under two more.
  assert.equal(c.retries, DEFAULT_RETRIES);
});

test("every kind needs a command", () => {
  assert.throws(() => resolveProcess("web", {}), /has no command/);
  assert.throws(() => resolveProcess("web", { command: "   " }), /has no command/);
});

test("an internal web is a field, not a fifth kind", () => {
  // Render models this as a separate service type (pserv). One field composes
  // instead: an agent server's private API is web + internal, beside a worker.
  const api = resolveProcess("web", { command: "npm start", visibility: "internal" }) as WebProcess;
  assert.equal(api.kind, "web");
  assert.equal(api.visibility, "internal");
  assert.equal(PRIMITIVE[api.kind], "service");
});

test("shutdownGrace parses, validates, and reports that it does not emit yet", () => {
  // terminationGracePeriodSeconds has no gcloud run flag — it is reachable only
  // once deploys emit YAML and replace. Accepting it silently would be the exact
  // defect this plan is closing, so it is recorded instead.
  const w = resolveProcess("queue", { command: "python -m worker", shutdownGrace: 120 }) as WorkerProcess;
  assert.equal(w.shutdownGrace, 120);

  const notes = unemittable(w);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /shutdownGrace is not emitted yet/);
  assert.match(notes[0], /step 4/);

  // And nothing is reported for a process that did not ask for it.
  assert.deepEqual(unemittable(resolveProcess("queue", { command: "x" })), []);
});

test("a Procfile supplies commands and supersonic.json supplies the rest", () => {
  const merged = mergeProcfile(
    { worker: { instances: 3 } },
    [{ name: "web", command: "npm start", line: 1 }, { name: "worker", command: "npm run q", line: 2 }],
  );

  // The command is not repeated in two files to say the worker wants 3 instances.
  assert.deepEqual(merged.worker, { command: "npm run q", instances: 3 });

  const resolved = resolveProcesses(merged);
  assert.deepEqual(resolved.map((p) => [p.name, p.kind]), [["web", "web"], ["worker", "worker"]]);
  assert.equal((resolved[1] as WorkerProcess).instances, 3);
});

test("one name with two different commands is refused, not silently resolved", () => {
  // Same rule that refuses `preDeploy` beside a different `release`: preferring
  // either leaves the other looking ignored, and here the cost is a worker
  // running a command its author believes they replaced.
  assert.throws(
    () => mergeProcfile({ web: { command: "npm run start:prod" } }, [{ name: "web", command: "npm start", line: 1 }]),
    (e: Error) => {
      assert.ok(e instanceof ProcessError);
      assert.match(e.message, /npm start/);
      assert.match(e.message, /npm run start:prod/);
      return true;
    },
  );

  // The SAME command in both is not a conflict — a repo may legitimately carry both.
  assert.doesNotThrow(() => mergeProcfile({ web: { command: "npm start" } }, [{ name: "web", command: "npm start", line: 1 }]));
});

test("a Procfile-only app needs no supersonic.json at all", () => {
  const merged = mergeProcfile(undefined, [
    { name: "web", command: "gunicorn app:app --bind 0.0.0.0:$PORT", line: 1 },
    { name: "bot", command: "python bot.py", line: 2 },
  ]);

  assert.deepEqual(resolveProcesses(merged).map((p) => p.kind), ["web", "worker"]);
});

test("web comes first, because it is the process the app's address lands on", () => {
  const resolved = resolveProcesses({
    zzz: { command: "python -m worker" },
    web: { command: "npm start" },
  });

  assert.equal(resolved[0].name, "web");
});

test("two webs on one service is refused, and says what to do instead", () => {
  assert.throws(
    () => resolveProcesses({ web: { command: "a" }, admin: { command: "b", kind: "web" } }),
    (e: Error) => {
      assert.match(e.message, /only one can answer/);
      assert.match(e.message, /two services/);
      return true;
    },
  );
});

test("two release processes is refused — the release phase runs exactly once", () => {
  assert.throws(
    () => resolveProcesses({ release: { command: "a" }, migrate: { command: "b", kind: "release" } }),
    /exactly once/,
  );
});

test("several workers and several crons are fine", () => {
  // The reason `processes` is keyed by NAME rather than by kind: an agent server
  // may drain two different queues, and `processes: { worker: … }` could hold one.
  const resolved = resolveProcesses({
    web: { command: "npm start" },
    emails: { command: "npm run q:email" },
    webhooks: { command: "npm run q:hooks" },
    nightly: { command: "npm run digest", schedule: "0 3 * * *" },
    hourly: { command: "npm run sync", schedule: "0 * * * *" },
  });

  assert.equal(resolved.filter((p) => p.kind === "worker").length, 2);
  assert.equal(resolved.filter((p) => p.kind === "cron").length, 2);
});

test("a default is never mistaken for something the author declared", () => {
  // `declared` is what makes assert-consumed and the emitters able to tell a
  // shrug from an instruction — every other field carries a default.
  assert.deepEqual(resolveProcess("web", { command: "npm start" }).declared, ["command"]);
  assert.deepEqual(
    resolveProcess("bot", { command: "x", instances: 2 }).declared.sort(),
    ["command", "instances"],
  );
});
