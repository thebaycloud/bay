import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * `runDeploy`, actually executed.
 *
 * Nothing else in this suite runs it. Before this file, seven test files
 * mentioned deploy-pipeline and every one was a comment or a source-text read —
 * so the 1700-line function that decides what every deploy does had no
 * behavioural coverage at all, and any change to it was green either way.
 *
 * That is a problem now rather than in general: Part 4 of docs/MAKE-DEPLOYS-WORK.md
 * splits this function into typed stages and routes every app down a build path
 * that today runs for almost nobody. Doing that without a test that runs it is
 * not a refactor, it is a rewrite with the lights off.
 *
 * WHAT IS FAKED, AND WHAT DELIBERATELY IS NOT
 *
 * The filesystem is real, `tar` is real, and every decision the pipeline makes
 * about a repository is real — those are the thing under test. Only the cloud is
 * faked: `spawn` answers for `gcloud` and for the detector subprocess, and the
 * modules that reach Postgres, Secret Manager or a model are replaced.
 *
 * The fake `spawn` is SELECTIVE for that reason. Faking it wholesale would also
 * fake `tar`, the build directory would be empty, and every assertion below would
 * be about a repository that does not exist.
 */

/* -------------------------------------------------------------------------- */
/* The fake cloud                                                             */
/* -------------------------------------------------------------------------- */

interface Recorded {
  /** Every argv the pipeline sent to a real command, in order. */
  argv: string[][];
  /** Everything `emit` received. */
  events: unknown[];
  /** Stage rows the recorder tried to write. */
  stages: { stage: string; outcome: string | null; lane: string }[];
}

/** A `gcloud`/`npm` reply, chosen by what the command line looks like. */
type Reply = { stdout?: string; code?: number };
type Replies = (argv: string[]) => Reply | undefined;

/**
 * The run in progress.
 *
 * Module-scoped because `mock.module` may only be installed ONCE per process —
 * a second call is `ERR_INVALID_STATE: The module is already mocked`. So the
 * mocks are installed once, permanently, and read whichever recorder is current;
 * `run()` swaps it. A fresh mock per test would be tidier and is not on offer.
 */
/**
 * The flags production runs under, set before the pipeline is imported.
 *
 * `RUNNER_ENABLED` and `PLANNER_ENABLED` are read at module load, so a test that
 * set them afterwards would be testing a configuration nothing runs. `PLANNER=0`
 * because the planner is a model call on the critical path and Part 3 takes it
 * off; `RUNNER=1` because `cloudbuild.yaml` says that is what is live.
 */
process.env.RUNNER ??= "1";
process.env.PLANNER ??= "0";

/** Which build implementation this process is exercising. See `generatedBuild`. */
const COLLAPSED = process.env.RUNNER === "0";

let active: Recorded = { argv: [], events: [], stages: [] };
let activeReplies: Replies = () => ({});

function fakeSpawn() {
  const real = require("node:child_process").spawn;
  return (cmd: string, args: string[], opts: unknown) => {
    const argv = [cmd, ...(args ?? [])];
    // `tar` and anything else local runs for real: the build directory it
    // produces is what the pipeline then reads, and a fake one would make every
    // detection assertion vacuous.
    if (cmd !== "gcloud" && cmd !== "npm") return real(cmd, args, opts);

    active.argv.push(argv);
    const reply = activeReplies(argv) ?? {};
    const p = new EventEmitter() as EventEmitter & Record<string, unknown>;
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.stdin = { on() {}, end() {} };
    setImmediate(() => {
      if (reply.stdout) (p.stdout as EventEmitter).emit("data", Buffer.from(reply.stdout));
      p.emit("close", reply.code ?? 0);
    });
    return p;
  };
}

/** A stack the detector would have returned, as its `--api` envelope. */
function detectorEnvelope(stack: Record<string, unknown>): string {
  return JSON.stringify({ stack: { language: "JavaScript", framework: "Node", installCommand: null, buildCommand: null, startCommand: "node index.js", serve: { mode: "container" }, ...stack } });
}

/**
 * Install every mock, then load the pipeline.
 *
 * Order matters: `mock.module` has to be in place before the import, because the
 * pipeline binds these at module load.
 */
let loaded: Promise<typeof import("@/lib/deploy-pipeline")["runDeploy"]> | null = null;

function loadPipeline() {
  return (loaded ??= install());
}

async function install() {
  mock.module("node:child_process", {
    namedExports: { spawn: fakeSpawn(), execFileSync },
  });

  const noop = () => {};
  const asyncNoop = async () => {};

  // Postgres.
  mock.module("@/lib/apps", { namedExports: { createAppRecord: asyncNoop, markAppLive: asyncNoop, markAppFailed: asyncNoop, isFirstDeploy: async () => true } });
  mock.module("@/lib/deploys", { namedExports: { setDeploy: noop } });
  mock.module("@/lib/plan-cache", { namedExports: { planKey: () => null, getCachedPlan: async () => null, putCachedPlan: asyncNoop } });
  mock.module("@/lib/pg-role", { namedExports: { ensureAppRole: asyncNoop, DB_PASSWORD_SECRET: "pw" } });

  // Stage rows: captured rather than written.
  const stages = await import("@/lib/stages");
  mock.module("@/lib/stages", {
    namedExports: {
      ...stages,
      StageRecorder: class {
        constructor(private slug: string, private lane: string) {}
        start(stage: string) { return { stage, startedAt: new Date(0) }; }
        async end(h: { stage: string }, outcome: string) { active.stages.push({ stage: h.stage, outcome, lane: this.lane }); }
        async around<T>(stage: string, fn: () => Promise<T>) {
          try { const out = await fn(); await this.end({ stage }, "ok"); return out; }
          catch (e) { await this.end({ stage }, "failed"); throw e; }
        }
        async skipped(stage: string) { await this.end({ stage }, "skipped"); }
      },
    },
  });

  // Secret Manager, object storage, the model, and the side effects.
  mock.module("@/lib/app-secrets", { namedExports: { putAppSecrets: async () => ({ stored: [], skipped: [] }), setSecretsFlag: () => "", grantBuildAccess: asyncNoop, readAppSecret: async () => null, allAppSecrets: async () => [] } });
  // Spread the real module, then override the parts that reach the network.
  //
  // Replacing it wholesale is how this file failed the moment `resolveImageDigest`
  // was added: the export simply became `undefined`, the render threw, no
  // Dockerfile was written, and the app silently fell back to the buildpack lane.
  // The harness caught it, but as a routing failure rather than as "your mock is
  // stale" — so the mock is now additive and a new export costs nothing.
  const gcpRest = await import("@/lib/gcp-rest");
  mock.module("@/lib/gcp-rest", {
    namedExports: {
      ...gcpRest,
      listObjectNames: async () => [],
      readObjectText: async () => null,
      writeObject: asyncNoop,
      describeServiceRest: async () => null,
      // Never a real registry call from a test; null is the "could not resolve"
      // answer the pipeline is built to tolerate.
      resolveImageDigest: async () => null,
    },
  });
  mock.module("@/lib/thumbnail", { namedExports: { requestThumbnail: noop } });
  mock.module("@/lib/deploy-notify", { namedExports: { notifyDeployFinished: asyncNoop } });
  mock.module("@/lib/clone-cache", { namedExports: { take: () => null } });
  mock.module("@/lib/verify-app", { namedExports: { verifyApp: async () => ({ ok: true, status: 200 }) } });
  mock.module("@/lib/verify-release", { namedExports: { verifyRelease: async () => ({ ok: true }) } });

  return (await import("@/lib/deploy-pipeline")).runDeploy;
}

/** A tar of a {path: contents} map, which is what an upload deploy carries. */
function tarball(files: Record<string, string>): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-src-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  const out = join(mkdtempSync(join(tmpdir(), "pipeline-tar-")), "src.tgz");
  execFileSync("tar", ["-czf", out, "-C", dir, "."]);
  return readFileSync(out);
}

function input(over: Record<string, unknown> = {}) {
  return {
    ownerId: "owner-1", ownerWorkspace: null, slug: "demo", friendlyName: "Demo",
    repoUrl: "", isUpload: true, isPrebuilt: false, prebuiltHash: "",
    secrets: {}, archive: null, cloneToken: null, runCmd: "",
    limits: { maxApps: 10, maxGrants: 10, autoFix: false, canRemoveBadge: false },
    ...over,
  } as never;
}

async function run(files: Record<string, string>, over: Record<string, unknown> = {}, replies: Replies = () => ({})) {
  const runDeploy = await loadPipeline();
  const rec: Recorded = { argv: [], events: [], stages: [] };
  active = rec;
  activeReplies = replies;
  // The pipeline swallows nothing at the top level, so a throw here is a real
  // failure of the deploy rather than of the harness — recorded, not hidden,
  // because "what does it do when it fails" is half of what is being pinned.
  try {
    await runDeploy(input({ archive: tarball(files), ...over }), (e) => rec.events.push(e));
  } catch (e) {
    rec.events.push({ type: "threw", message: e instanceof Error ? e.message : String(e) });
  }
  return rec;
}

/* -------------------------------------------------------------------------- */
/* What it currently does                                                     */
/* -------------------------------------------------------------------------- */

const NEEDS_MOCKS = { skip: process.env.PIPELINE_HARNESS === "off" };

test("an upload is unpacked, detected, and reaches a deploy", NEEDS_MOCKS, async () => {
  const rec = await run(
    { "package.json": '{"scripts":{"start":"node index.js"}}', "index.js": "console.log(1)" },
    {},
    (argv) => (argv.includes("--api") ? { stdout: detectorEnvelope({}) } : {}),
  );

  const names = rec.stages.map((s) => s.stage);
  assert.ok(names.includes("unpack"), `stages were: ${names.join(", ")}`);
  assert.ok(names.includes("detect"), `stages were: ${names.join(", ")}`);
  assert.ok(rec.events.length > 0, "the deploy emitted nothing at all");
});

/** The lane the deploy was charged to — the routing decision, in one word. */
const laneOf = (rec: Recorded) => rec.stages.map((s) => s.lane).filter((l) => l !== "unknown").at(-1) ?? "unknown";

/** Did it build an image, or hand the source to somebody else? */
const builtAnImage = (rec: Recorded) => rec.argv.some((a) => a[0] === "gcloud" && a[1] === "builds" && a[2] === "submit");
const deployedFromSource = (rec: Recorded) => rec.argv.some((a) => a.includes("--source"));

const STATIC_STACK = { serve: { mode: "static", outputDir: "." }, language: "Static", framework: "Static site", startCommand: "(nginx)" };
/**
 * The detector's answer, plus a Cloud Run deploy that reports a URL.
 *
 * The URL is not decoration. `run deploy` returning no `status.url` is a FAILED
 * deploy as far as the pipeline is concerned, and the sibling loop is gated on
 * `result.ok` — so without this every test silently stopped at the primary and
 * would have "passed" a sibling assertion by never running one.
 */
const detect = (stack: Record<string, unknown> = {}): Replies => (argv) => {
  if (argv.includes("--api")) return { stdout: detectorEnvelope(stack) };
  if (argv[1] === "run" && argv[2] === "deploy") {
    const name = argv[3] ?? "demo";
    return { stdout: JSON.stringify({ status: { url: `https://${name}-test.a.run.app` } }) };
  }
  return {};
};

test("a repo that ships its own Dockerfile builds an image — and must keep doing so", NEEDS_MOCKS, async () => {
  // The author was explicit. This routing is not what the collapse changes, so it
  // is here to prove the collapse did not disturb it.
  const rec = await run({ "Dockerfile": "FROM alpine\n", "index.js": "" }, {}, detect());
  assert.equal(laneOf(rec), "container");
  assert.ok(builtAnImage(rec), "a committed Dockerfile must be built, not handed to a source deploy");
});

test("a static site publishes files and builds no image — and must keep doing so", NEEDS_MOCKS, async () => {
  // Part 1's diagram marks this lane "(unchanged)". If the collapse ever routes a
  // static site through an image build, three classes of site that deploy
  // correctly today get containerised around an entrypoint the build never emits.
  const rec = await run({ "index.html": "<h1>hi</h1>" }, {}, detect(STATIC_STACK));
  assert.equal(laneOf(rec), "static");
  assert.ok(!builtAnImage(rec), "a static site must not build a container image");
  assert.ok(rec.argv.some((a) => a.includes("rsync")), "the static lane publishes with storage rsync");
});

test("a pinned runtime the runner cannot serve already builds a generated image", NEEDS_MOCKS, async () => {
  // The path docs/MAKE-DEPLOYS-WORK.md says "runs for almost nobody": reachable
  // only because `.python-version` names something the runner does not have.
  const rec = await run(
    { "requirements.txt": "flask\n", "app.py": "", ".python-version": "3.11\n" },
    {},
    detect({ language: "Python", framework: "Flask", startCommand: "gunicorn app:app --bind 0.0.0.0:8000" }),
  );
  assert.equal(laneOf(rec), "container");
  assert.ok(builtAnImage(rec));
});

test("an ordinary Node app: buildpacks under RUNNER=1, its own image under RUNNER=0", NEEDS_MOCKS, async () => {
  // THE ROW THE COLLAPSE CHANGES, asserted in both directions from one file so
  // the cutover is visible rather than inferred.
  //
  // A plain Node app with no Dockerfile and no unservable pin takes `run deploy
  // --source` today — the buildpack lane, which step 4 deletes. Under RUNNER=0 it
  // builds a generated image instead, which is what makes "any language, any
  // version" true for the apps that are not runtime-pinned.
  const rec = await run(
    { "package.json": '{"scripts":{"start":"node index.js"}}', "index.js": "" },
    {},
    detect(),
  );

  if (!COLLAPSED) {
    assert.equal(laneOf(rec), "buildpack");
    assert.ok(!builtAnImage(rec), "the buildpack lane builds no image of its own");
    assert.ok(deployedFromSource(rec), "it hands the source to Cloud Run");
    return;
  }
  assert.equal(laneOf(rec), "container", "the collapse must route this to the container lane");
  assert.ok(builtAnImage(rec), "the collapse must build a generated image");
  assert.ok(!deployedFromSource(rec), "nothing should still be handed to buildpacks");
});

test("the collapse does not disturb a static site", { ...NEEDS_MOCKS, skip: !COLLAPSED }, async () => {
  // Checked under RUNNER=0 specifically. Part 1 marks this lane "(unchanged)", and
  // the failure it is guarding against is silent: a site whose build produces
  // files and nothing to run, containerised around an entrypoint the build never
  // emits, comes up as a container that exits immediately.
  const rec = await run({ "index.html": "<h1>hi</h1>" }, {}, detect(STATIC_STACK));
  assert.equal(laneOf(rec), "static");
  assert.ok(!builtAnImage(rec));
});

test("a sibling builds from its own directory into its own image", { ...NEEDS_MOCKS, skip: !COLLAPSED }, async () => {
  // `deploySibling` refused anything that was not node or python, because a
  // sibling was always a runner bundle and the runner has two images. That was
  // never a statement about siblings. With a generated image a sibling can be Go —
  // and, more importantly, five things that were shared stop colliding: the image
  // name, the Dockerfile filename, the layer-cache repo, the build context and
  // the cloudbuild.yaml path were all one-per-app, so two siblings overwrote each
  // other.
  const rec = await run(
    {
      "supersonic.json": JSON.stringify({
        version: 1,
        services: [
          { name: "web", dir: "web", language: "node", start: "node server.js", path: "/" },
          { name: "api", dir: "api", language: "other", start: "/app/server", path: "/api" },
        ],
      }),
      "web/package.json": '{"scripts":{"start":"node server.js"}}',
      "web/server.js": "",
      "api/go.mod": "module api\n\ngo 1.23\n",
      "api/main.go": "package main\nfunc main(){}\n",
    },
    {},
    detect(),
  );

  const submits = rec.argv.filter((a) => a[1] === "builds" && a[2] === "submit").map((a) => a[3]);
  assert.ok(submits.length >= 2, `expected a build per service, got: ${submits.join(", ")}`);
  // Each build's context is the service's own directory, which is what makes
  // `Dockerfile` and `cloudbuild.yaml` unambiguous inside it.
  assert.ok(submits.some((c) => c.endsWith("/api")), `no build rooted at api/: ${submits.join(", ")}`);

  // …and the Go sibling is no longer refused for being Go.
  const refusal = rec.events.some((e) => JSON.stringify(e).includes("must be node or python"));
  assert.ok(!refusal, "a generated image has no language restriction to enforce");
});
