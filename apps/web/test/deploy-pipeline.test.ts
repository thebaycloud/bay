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
  /**
   * Every apps.runtime write, in order.
   *
   * The one fact that decides whether a node is still handed this app:
   * desiredFor only yields placements whose app reads 'fleet'. A deploy that
   * goes to Cloud Run without writing 'cloudrun' here leaves the node running a
   * second copy of an app Cloud Run is already serving.
   */
  runtimeWrites: { slug: string; runtime: string }[];
  /** Every argv the pipeline sent to a real command, in order. */
  argv: string[][];
  /** Everything `emit` received. */
  events: unknown[];
  /** Stage rows the recorder tried to write. */
  stages: { stage: string; outcome: string | null; lane: string }[];
  /**
   * Every spec handed to a node, in order.
   *
   * The fleet branch's only externally visible product. What it PLACES is the
   * thing that decides which code the node runs, and it is not derivable from
   * argv: `gcloud builds submit` says an image was built and says nothing at all
   * about which reference was then written into the placement row.
   */
  placements: { slug: string; node: string; spec: { image: string; memoryBytes: number; cpuShares: number; processes?: { name: string; kind: string; command?: string[] }[] } }[];
  /**
   * Every repair the pipeline handed off, with the runtime it named and the
   * runtime its `redeploy` closure actually reached.
   *
   * Two fields rather than one because the defect was precisely that they
   * disagreed: the agent was told "Cloud Run" and handed the Cloud Run closure
   * on a deploy whose DATABASE_URL named 10.200.0.1.
   */
  repairs: { named: string; placedAgain: boolean; ranCloudRunDeploy: boolean }[];
  /**
   * Every `markAppLive` call, with the arguments the pipeline chose.
   *
   * `hasWeb` is the whole reason this is captured rather than no-opped. It is
   * the row the edge reads to decide whether an app with no URL is a healthy
   * worker or a dead deploy, and it is derived here — from a Procfile, through
   * readProcesses and isServiceless — not passed in by a test. Asserting it
   * against a hand-written constant would prove nothing; running the pipeline
   * and reading what came out the end is the only way this can be wrong and
   * still fail.
   */
  live: { slug: string; runUrl: string; hasWeb: unknown }[];
}

/** A `gcloud`/`npm` reply, chosen by what the command line looks like. */
type Reply = { stdout?: string; stderr?: string; code?: number };
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
/**
 * Read at module load, so it has to be set before the pipeline is imported.
 * Without it `runFleetDeploy` refuses before it builds anything and the fleet
 * branch below would pass by never running.
 */
process.env.FLEET_LB ??= "10.0.0.9";

/**
 * What the registry answers for a tag, switchable per test.
 *
 * A digest by default, because that is what a registry does for an image the
 * build just pushed to it. The null case is its own test: an unresolvable
 * digest must fail the deploy rather than quietly place a tag.
 */
const A_DIGEST = `sha256:${"ab".repeat(32)}`;
let digestReply: string | null = A_DIGEST;

/** What the fleet load balancer answers, so a failed verification is reachable. */
let probeCode = 200;

/**
 * The fleet's placement table, in memory — one row per slug, overwritten on
 * every `placeApp` and dropped on `unplaceApp`, exactly like the real
 * `fleet_placements` upsert (`fleet.ts:78-86`) this stands in for.
 *
 * A map rather than an appended log, unlike `active.placements` below: that
 * recorder answers "what did the pipeline try, in order" and this answers "what
 * does the fleet currently believe this app runs" — the two questions
 * `rollBackToLastGood` conflated before this ticket, by asking a Cloud-Run-only
 * function the second one and treating its answer as though it were the first.
 *
 * Empty by default, so every test that never touches it keeps exercising
 * exactly what it always did — a slug the fleet has never placed. Only the
 * fleet-rollback tests below seed it, and only they are responsible for
 * clearing it again.
 */
let placementTable = new Map<string, { node: string; spec: unknown }>();

/**
 * What Secret Manager holds for the app, switchable per test.
 *
 * Empty by default, so every test written before this one keeps exercising the
 * app it always did: an app with no secrets.
 */
let storedSecrets: { key: string; name: string }[] = [];

/** Which build implementation this process is exercising. See `generatedBuild`. */
const COLLAPSED = process.env.RUNNER === "0";

let active: Recorded = { argv: [], events: [], stages: [], placements: [], repairs: [], live: [], runtimeWrites: [] };
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
      if (reply.stderr) (p.stderr as EventEmitter).emit("data", Buffer.from(reply.stderr));
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
  // `markAppLive` is captured rather than no-opped: its `hasWeb` argument is a
  // decision the pipeline makes, not a value handed to it, and it is the one the
  // edge trusts when it decides whether a URL with nothing behind it is broken.
  const markAppLive = async (slug: string, runUrl: string, _hash?: unknown, _routes?: unknown, hasWeb?: unknown) => {
    active.live.push({ slug, runUrl, hasWeb });
  };
  mock.module("@/lib/apps", { namedExports: { createAppRecord: asyncNoop, markAppLive, markAppFailed: asyncNoop, isFirstDeploy: async () => true } });
  mock.module("@/lib/deploys", { namedExports: { setDeploy: noop } });
  mock.module("@/lib/plan-cache", { namedExports: { planKey: () => null, getCachedPlan: async () => null, putCachedPlan: asyncNoop } });
  mock.module("@/lib/pg-role", { namedExports: { ensureAppRole: asyncNoop, DB_PASSWORD_SECRET: "pw" } });

  // Stage rows: captured rather than written.
  //
  // SUBCLASSED rather than reimplemented. A hand-written stand-in has to be
  // updated every time the real recorder grows a method, and it fails silently
  // when it is not: `failedStage()` was added and this file kept passing, because
  // the only caller is the outer catch and every test here succeeded. Extending
  // the real class means new behaviour arrives for free and only the sink — the
  // one part that talks to Postgres — is replaced.
  const stages = await import("@/lib/stages");
  const capturingSink = {
    async write(r: { stage: string; outcome: string | null; lane: string }) {
      active.stages.push({ stage: r.stage, outcome: r.outcome, lane: r.lane });
    },
  };
  mock.module("@/lib/stages", {
    namedExports: {
      ...stages,
      StageRecorder: class extends stages.StageRecorder {
        constructor(slug: string, lane: string) {
          super(slug, lane as never, capturingSink as never);
        }
      },
    },
  });

  // Failure rows: swallowed rather than written, for the same reason and by the
  // same means as stage rows just above. `FailureRecorder` was built with an
  // identical injectable-sink constructor (`sink: FailureSink = postgresSink`)
  // specifically so a caller can replace only the part that talks to Postgres —
  // its own logic (one row per deploy, "skipped" never left as an uninformative
  // null) stays real and under test in deploy-failures.test.ts. Without this,
  // every test below that fails a deploy reached the live sink and printed
  // `ECONNREFUSED` into passing test output.
  const deployFailures = await import("@/lib/deploy-failures");
  const noopFailureSink = {
    async insert() { return "test-failure-row"; },
    async setRepair() {},
  };
  mock.module("@/lib/deploy-failures", {
    namedExports: {
      ...deployFailures,
      FailureRecorder: class extends deployFailures.FailureRecorder {
        constructor() {
          super(noopFailureSink as never);
        }
      },
    },
  });

  // Secret Manager, object storage, the model, and the side effects.
  mock.module("@/lib/app-secrets", { namedExports: {
    putAppSecrets: async () => ({ stored: [], skipped: [] }),
    setSecretsFlag: () => "",
    grantBuildAccess: asyncNoop,
    readAppSecret: async () => null,
    // What Secret Manager says the app HAS, which is not what this deploy
    // stored. Switchable per test because the distinction is the whole point of
    // the grant: an app on its second deploy stores nothing and still has to be
    // readable by the node.
    allAppSecrets: async () => storedSecrets,
  } });
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
      // Never a real registry call from a test. It answers with a digest,
      // because that is what a registry does — and because the fleet branch now
      // depends on the answer rather than tolerating its absence.
      resolveImageDigest: async () => digestReply,
    },
  });

  // The fleet, without a node, a database or a load balancer.
  //
  // Every port `placeOnFleet` is given comes from here, so the placement row
  // this deploy would have written is capturable — and it is the only evidence
  // that says which image the node was told to run.
  mock.module("@/lib/fleet", {
    namedExports: {
      chooseNode: async () => "fleet-lab-1",
      placeApp: async (slug: string, node: string, spec: never) => {
        active.placements.push({ slug, node, spec });
        placementTable.set(slug, { node, spec });
      },
      unplaceApp: async (slug: string) => {
        placementTable.delete(slug);
      },
      placementFor: async (slug: string) => placementTable.get(slug) ?? null,
      runtimeOf: async () => "cloudrun",
      setRuntime: async (slug: string, runtime: string) => {
        active.runtimeWrites.push({ slug, runtime });
      },
      // No node blames itself here, which is what keeps these deploys' failures
      // the app's — the repair-agent tests below depend on that being the
      // default, and a fleet failure the node DOES claim is tested where it
      // belongs, in fleet-place.test.ts.
      nodeFaultFor: async () => null,
      // A node that faithfully runs what it was placed.
      //
      // Derived from the placement rather than hardcoded, so it cannot agree
      // with a spec the pipeline never wrote: if the pipeline places the wrong
      // image or the wrong argv, this reports the wrong one back and the real
      // `runVerdict` — which is NOT mocked — refuses it. What is faked is the
      // node, not the judgement.
      runningOnNode: async (slug: string, node: string) => {
        const placed = active.placements.filter((p) => p.slug === slug && p.node === node).at(-1);
        if (!placed) return [];
        return (placed.spec.processes ?? [{ name: "web", kind: "web" }])
          .filter((pr) => pr.kind === "web" || pr.kind === "worker")
          .map((pr) => ({ slug, process: pr.name, image: placed.spec.image, command: pr.command }));
      },
    },
  });
  // Additive, for the same reason gcp-rest is: `chooseRuntime`, `placeOnFleet`
  // and `fleetEligibility` are the logic under test and must stay real. Only
  // the one function that opens a socket is replaced.
  const fleetPlace = await import("@/lib/fleet-place");
  mock.module("@/lib/fleet-place", {
    namedExports: { ...fleetPlace, fleetProbe: async () => ({ code: probeCode }) },
  });

  // The repair agent, replaced by a recorder that calls its own `redeploy` tool
  // exactly once.
  //
  // Calling it is the whole point: which runtime a repair reaches is not visible
  // from the arguments — a closure named `redeploy` looks identical either way —
  // and the only honest way to find out is to invoke it and watch what happens.
  const agent = await import("@/lib/agent");
  mock.module("@/lib/agent", {
    namedExports: {
      ...agent,
      repairDeploy: async (o: { runtime: string; redeploy: () => Promise<{ ok: boolean }> }) => {
        const placedBefore = active.placements.length;
        const argvBefore = active.argv.length;
        await o.redeploy();
        active.repairs.push({
          named: o.runtime,
          placedAgain: active.placements.length > placedBefore,
          ranCloudRunDeploy: active.argv.slice(argvBefore).some((a) => a[1] === "run" && a[2] === "deploy"),
        });
        return { ok: false, changes: [], summary: "the harness fixes nothing; it only records where the repair went" };
      },
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
  const rec: Recorded = { argv: [], events: [], stages: [], placements: [], repairs: [], live: [], runtimeWrites: [] };
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

test("a worker-only app records that it has no web process; an ordinary one records that it has", NEEDS_MOCKS, async () => {
  // hdhxq's exact shape: a Procfile with one `bot` line and no `web` line. The
  // deploy succeeds, deploys no Cloud Run service, and writes no run_url — and
  // for two days the edge read that empty run_url as a dead deploy and served a
  // customer's working Telegram bot a "This deploy stopped" page.
  //
  // The assertion is on what the PIPELINE derived, not on a value this test
  // handed it: the Procfile below goes through readProcesses and isServiceless
  // to reach markAppLive. Nothing here can agree with the implementation by
  // construction — if `!serviceless` at the call site were dropped, inverted, or
  // computed from something else, this fails.
  const bot = await run(
    { "Procfile": "bot: python bot.py\n", "bot.py": "print(1)", "requirements.txt": "requests\n" },
    // `ownerWorkspace` is what gates the go-live write at all: the harness
    // defaults it to null, under which markAppLive is never reached and every
    // assertion below would pass by never running.
    { ownerWorkspace: "ws-1" },
    detect({ language: "Python", framework: "Telegram bot", startCommand: "python bot.py" }),
  );
  assert.deepEqual(
    bot.live.map((l) => l.hasWeb), [false],
    `a Procfile with no web line must record has_web=false; markAppLive saw ${JSON.stringify(bot.live)}`,
  );
  // And the reason the column is needed at all: there is no URL to fall back on.
  assert.equal(bot.live[0].runUrl, "", "a worker-only app deploys no service, so it has no run_url");

  // The other direction, from the same producer. Without this the test above
  // would also pass if markAppLive were simply always told `false`.
  const web = await run(
    { "Procfile": "web: node server.js\n", "server.js": "", "package.json": '{"scripts":{"start":"node server.js"}}' },
    { ownerWorkspace: "ws-1" },
    detect(),
  );
  assert.deepEqual(
    web.live.map((l) => l.hasWeb), [true],
    `a Procfile with a web line must record has_web=true; markAppLive saw ${JSON.stringify(web.live)}`,
  );
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

test("a failure says which stage it died in", NEEDS_MOCKS, async () => {
  // Part 5 needs this and nothing had it. `classify` was handed a bare string and
  // had to infer platform-versus-app blame from its wording, which is how one
  // `permission denied` inside a build log spoke for a whole deploy. Where the
  // failure happened is a fact; it should not have to be read out of prose.
  const rec = await run(
    { "package.json": '{"scripts":{"start":"node index.js"}}', "index.js": "" },
    {},
    (argv) => {
      if (argv.includes("--api")) return { stdout: detectorEnvelope({}) };
      // The build fails, which is the dominant failure mode now that every app
      // builds an image.
      if (argv[1] === "builds" && argv[2] === "submit") return { code: 1 };
      if (argv[1] === "run" && argv[2] === "deploy") return { code: 1 };
      return {};
    },
  );

  const failed = rec.stages.filter((s) => s.outcome === "failed").map((s) => s.stage);
  assert.ok(failed.length > 0, `nothing recorded a failure; stages were ${rec.stages.map((s) => s.stage).join(", ")}`);

  const errors = rec.events.filter((e) => (e as { type?: string }).type === "error");
  assert.ok(errors.length > 0, "a failed deploy must emit an error");
  const text = JSON.stringify(errors);
  assert.match(text, /failed during: \w/, `the error must name the stage — got ${text.slice(0, 400)}`);
});

test("a fleet app's real crash reaches the repair agent, not just the symptom", NEEDS_MOCKS, async () => {
  // fetchContainerError used to read Cloud Logging with
  // `--format=value(textPayload)`. A Cloud Run entry carries its text there, but
  // an entry the ops agent shipped from a fleet node carries it in
  // `jsonPayload.message` — so for a fleet app the function silently returned
  // null on every call, and the "didn't start on $PORT" symptom reached the
  // repair agent with no actual cause attached. That is exactly the guess this
  // function exists to prevent (see the comment above `fetchContainerError`).
  const distinctiveCrash = "TypeError: Cannot read properties of undefined (reading 'db')";
  const rec = await run(
    { "package.json": '{"scripts":{"start":"node index.js"}}', "index.js": "" },
    {},
    (argv) => {
      if (argv.includes("--api")) return { stdout: detectorEnvelope({}) };
      // The deploy itself fails at container startup — the one path that makes
      // the pipeline go fetch the container's real crash log.
      if (argv[1] === "run" && argv[2] === "deploy") {
        return { code: 1, stderr: "Revision failed to start and listen on the port defined by the PORT=8080\n" };
      }
      // The fleet node's log entry for that crash — jsonPayload, not textPayload.
      if (argv[1] === "logging" && argv[2] === "read") {
        return { stdout: JSON.stringify([{ jsonPayload: { message: distinctiveCrash } }]) };
      }
      return {};
    },
  );

  const errors = rec.events.filter((e) => (e as { type?: string }).type === "error");
  assert.ok(errors.length > 0, "a container that doesn't start on $PORT must still fail the deploy");
  const text = JSON.stringify(errors);
  assert.ok(
    text.includes(distinctiveCrash),
    `the real crash never reached the repair agent — reading only textPayload returns null for a fleet app; got ${text.slice(0, 500)}`,
  );
  // Not just a substring hit on the raw JSON blob: the reader must have actually
  // parsed the entry and pulled `.message` out of it, not treated the whole
  // `--format=json` response as one line of text (which happens to still
  // contain the crash string, so a looser assertion here would pass either way).
  assert.ok(
    !text.includes("jsonPayload"),
    `the log entry was not parsed — its raw JSON leaked into the error instead of just the message; got ${text.slice(0, 500)}`,
  );
});

test("a deploy that comes up broken puts the last working version back", NEEDS_MOCKS, async () => {
  // The case that hurts is NOT a container that fails to start — Cloud Run refuses
  // to promote one of those, so traffic never moves. It is a container that
  // starts, binds $PORT, becomes Ready, takes 100% of traffic and then answers 500
  // to everything: healthy by Cloud Run's definition, down by everyone else's.
  //
  // That used to stay live until a person noticed and ran `supersonic rollback`,
  // which is not "no operator" in any sense.
  const rec = await run(
    { "package.json": '{"scripts":{"start":"node index.js"}}', "index.js": "" },
    {},
    (argv) => {
      if (argv.includes("--api")) return { stdout: detectorEnvelope({}) };
      // Deploys fine…
      if (argv[1] === "run" && argv[2] === "deploy") {
        return { stdout: JSON.stringify({ status: { url: "https://demo-test.a.run.app" } }) };
      }
      // …and the app itself is broken, which the probe finds.
      if (argv[1] === "run" && argv[2] === "revisions") {
        return { stdout: JSON.stringify({ items: [
          { metadata: { name: "demo-00002", creationTimestamp: "2026-08-03T02:00:00Z" }, status: { conditions: [{ type: "Ready", status: "True" }] } },
          { metadata: { name: "demo-00001", creationTimestamp: "2026-08-03T01:00:00Z" }, status: { conditions: [{ type: "Ready", status: "True" }] } },
        ] }) };
      }
      return {};
    },
  );

  // Whether the probe failed depends on mocked verifyApp, so assert on the
  // capability rather than on this particular run: if the pipeline reported a
  // failure at all, it must have tried to put the previous revision back.
  const failed = rec.events.some((e) => (e as { type?: string }).type === "error");
  const rolledBack = rec.argv.some((a) => a.includes("update-traffic"));
  if (failed) {
    assert.ok(rolledBack, `a failed deploy must roll traffic back; argv was ${JSON.stringify(rec.argv.map((a) => a.slice(0, 3)))}`);
  } else {
    assert.ok(!rolledBack, "a successful deploy must never roll back");
  }
});

/**
 * Run one deploy down the fleet branch.
 *
 * `FLEET_APPS` is read per call rather than at load, so it can be set for one
 * test and taken away again — and it MUST be taken away again, or every test
 * declared after this one silently changes runtime.
 */
async function onFleet(files: Record<string, string>, replies: Replies = detect(), over: Record<string, unknown> = {}) {
  process.env.FLEET_APPS = "demo";
  try {
    return await run(files, over, replies);
  } finally {
    delete process.env.FLEET_APPS;
  }
}

test("a fleet redeploy that fails after taking traffic gets the previous version back", NEEDS_MOCKS, async () => {
  // The bug docs/research/cloud-run-shape.md found and the GitHub issue named:
  // `rollBackToLastGood` guarded `staticServe || serviceless` but not `toFleet`,
  // so a failed fleet deploy called Cloud Run's OWN `rollback()` — `gcloud run
  // revisions list` against a service that was never created — which threw and
  // was swallowed as noise. Nothing target-aware ever ran.
  //
  // What actually undoes a broken fleet placement is `placeOnFleet` itself
  // (fleet-place.ts:638-644): it reads the previous spec before overwriting the
  // row, and puts it straight back the moment its own verify fails. This test
  // seeds that previous placement, forces the verify to fail the way the issue
  // describes (the container answers, so it takes traffic — then the probe
  // reads it as broken), and checks the fleet ends up back on the seeded
  // version rather than stuck on the one that just failed.
  const seedSpec = { image: "seed-image-marker@sha256:" + "cd".repeat(32), memoryBytes: 999, cpuShares: 999 };
  placementTable.set("demo", { node: "fleet-lab-0", spec: seedSpec });
  probeCode = 503;
  let rec: Recorded;
  // Read back before the `finally` clears it — the table has to be reset for
  // tests that run after this one, but that reset must not run before this
  // test has had a chance to read what the deploy actually left behind.
  let finalPlacement: { node: string; spec: unknown } | undefined;
  try {
    rec = await onFleet({ "Dockerfile": "FROM alpine\n", "index.js": "" });
    finalPlacement = placementTable.get("demo");
  } finally {
    probeCode = 200;
    placementTable.delete("demo");
  }

  const errors = rec.events.filter((e) => (e as { type?: string }).type === "error");
  assert.ok(errors.length > 0, "a fleet app that fails its verify must still report a failed deploy");

  // Cloud Run's OWN rollback machinery must never run for a fleet app — there is
  // no service for `gcloud run revisions list` to find, and running it anyway is
  // exactly the wrong-target call this ticket removes.
  assert.ok(
    !rec.argv.some((a) => a[1] === "run" && a[2] === "revisions"),
    `a fleet failure must not ask Cloud Run for revisions; argv was ${JSON.stringify(rec.argv.map((a) => a.slice(0, 3)))}`,
  );
  assert.ok(
    !rec.argv.some((a) => a.includes("update-traffic")),
    "a fleet failure must not move Cloud Run traffic — there is no Cloud Run service to move it on",
  );

  // The fleet's own placement table — not just the append-only log of attempts —
  // must end up back on the seeded version. `placeOnFleet`'s restore call is the
  // last write for this slug in a failed verify, so the LAST entry in the log is
  // also the one worth reading.
  assert.equal(rec.placements.at(-1)?.node, "fleet-lab-0", "the previous placement's node must be restored, not the node this failed attempt chose");
  assert.deepEqual(rec.placements.at(-1)?.spec, seedSpec, "the previous spec must be restored verbatim");
  assert.deepEqual(finalPlacement, { node: "fleet-lab-0", spec: seedSpec }, "the fleet's placement table must read back the restored version, not the broken one");

  // Said honestly, not silently: the log line and the recorded failure both
  // have to tell the user what actually happened, per the ticket.
  const text = JSON.stringify(errors);
  assert.match(text, /previous version/i, `the failure must say what happened to the previous version, not stay silent about rollback; got ${text.slice(0, 400)}`);
});

test("a first-ever fleet deploy that fails has nothing to roll back to, and says so instead of erroring", NEEDS_MOCKS, async () => {
  // The other half of the acceptance criteria: a slug with no prior placement
  // must fail cleanly. Before this ticket the generic safety net called Cloud
  // Run's `rollback()`, which throws "no previous revision to roll back to" for
  // ANY app — that exception was caught, so this half already degraded
  // gracefully by accident. The fix must keep it that way on purpose: no throw
  // escapes `rollBackToLastGood`, and the placement table stays empty rather
  // than growing a row that points at nothing.
  probeCode = 503;
  let rec: Recorded;
  let finalPlacement: { node: string; spec: unknown } | undefined;
  try {
    rec = await onFleet({ "Dockerfile": "FROM alpine\n", "index.js": "" });
    finalPlacement = placementTable.get("demo");
  } finally {
    probeCode = 200;
    placementTable.delete("demo");
  }

  const errors = rec.events.filter((e) => (e as { type?: string }).type === "error");
  assert.ok(errors.length > 0, "a first fleet deploy that fails its verify must still report a failed deploy");
  assert.equal(rec.events.some((e) => (e as { type?: string }).type === "threw"), false, "rollBackToLastGood must never throw on a slug with nothing to roll back to");
  assert.equal(finalPlacement, undefined, "a first deploy with no previous placement must end up unplaced, not pointing at a broken version");
});

/** Pro, so the repair agent runs at all — Basic gets a paste-ready prompt instead. */
const AUTO_FIX = { limits: { maxApps: 10, maxGrants: 10, autoFix: true, canRemoveBadge: false } };

test("a fleet deploy places the image by digest, never a moving tag", NEEDS_MOCKS, async () => {
  // The defect this is here to keep dead: `buildImage` returned the constant
  // `${IMAGE}:latest`, so the spec placed on the node carried the same string on
  // every deploy. The agent restarts a sandbox when the image or the command
  // CHANGES (services/fleet/agent/main.go), an unchanged tag is not a change,
  // and `EnsureImage` resolves `slug:latest` out of the node's own content store
  // without asking the registry. So a redeploy stopped nothing, pulled nothing,
  // and left the previous version serving — while the probe got its 200 from
  // that old sandbox, the verdict passed, and the dashboard reported the new
  // version live. A tag is not evidence; a digest is.
  const rec = await onFleet({ "Dockerfile": "FROM alpine\n", "index.js": "" });

  assert.ok(rec.placements.length > 0, `nothing was placed; stages were ${rec.stages.map((s) => s.stage).join(", ")}`);
  const { image } = rec.placements.at(-1)!.spec;
  assert.doesNotMatch(image, /:latest$/, `a tag was placed, so a redeploy changes nothing on the node: ${image}`);
  assert.match(image, /@sha256:[0-9a-f]{64}$/, `the placed reference must be immutable, got: ${image}`);
});

test("a digest that cannot be resolved fails the deploy instead of placing a tag", NEEDS_MOCKS, async () => {
  // The half of the fix that is easy to leave out. Falling back to `:latest`
  // when the registry will not answer restores the bug exactly, and hides it
  // behind a deploy that reports success — which is strictly worse than the
  // original, because now there is a line of code that looks like a guard.
  digestReply = null;
  let rec: Recorded;
  try {
    rec = await onFleet({ "Dockerfile": "FROM alpine\n", "index.js": "" });
  } finally {
    digestReply = A_DIGEST;
  }

  assert.equal(rec.placements.length, 0, `nothing may be placed without a digest, placed: ${JSON.stringify(rec.placements.map((p) => p.spec.image))}`);
  const errors = rec.events.filter((e) => (e as { type?: string }).type === "error");
  assert.ok(errors.length > 0, "an unresolvable digest must fail the deploy");
  assert.match(JSON.stringify(errors), /digest/i, `the error must say what could not be resolved — got ${JSON.stringify(errors).slice(0, 400)}`);
});

test("a repair of a fleet deploy redeploys to the fleet, and is told so", NEEDS_MOCKS, async () => {
  // `redeploy: runDeploy` was passed at both repair call sites — the Cloud Run
  // branch — so a fleet deploy blamed on the app ended with the app on Cloud
  // Run. `dbAt` had already resolved to FLEET_DB, so its DATABASE_URL, PGHOST
  // and POSTGRES_HOST all named 10.200.0.1, which no Cloud Run revision can
  // route to: the repaired app started, served its homepage, answered the probe
  // 200 and failed every request that touched data. Worse on a repeat, because
  // `placeOnFleet` had restored the previous placement — so the node went on
  // serving the old version while `markAppLive` wrote a Cloud Run url. Two live
  // runtimes for one app is the defect class this piece exists to end, and this
  // was the surviving way back into it.
  probeCode = 503;
  let rec: Recorded;
  try {
    rec = await onFleet({ "Dockerfile": "FROM alpine\n", "index.js": "" }, detect(), AUTO_FIX);
  } finally {
    probeCode = 200;
  }

  assert.equal(rec.repairs.length, 1, `the repair agent must still run on a fleet failure — the ledger's Task 9 ruling. Events: ${JSON.stringify(rec.events).slice(0, 300)}`);
  const [repair] = rec.repairs;
  // The closure first, because it is the one that moves an app: a description
  // that lies is bad, a redeploy that lands on the wrong runtime is an outage.
  assert.ok(!repair.ranCloudRunDeploy, "a fleet deploy must never be repaired onto Cloud Run — its DATABASE_URL names 10.200.0.1");
  assert.ok(repair.placedAgain, "the repair's redeploy must place on the fleet again");
  assert.equal(repair.named, "fleet", "the agent must be told which runtime its redeploy reaches");
});

test("a repair of a Cloud Run deploy still redeploys to Cloud Run", NEEDS_MOCKS, async () => {
  // The other half, and not a formality: a fix that routes every repair to the
  // fleet is the same bug pointing the other way, and it would be invisible in
  // a suite that only ever exercised the fleet.
  const rec = await run(
    { "Dockerfile": "FROM alpine\n", "index.js": "" },
    AUTO_FIX,
    (argv) => {
      if (argv.includes("--api")) return { stdout: detectorEnvelope({}) };
      if (argv[1] === "run" && argv[2] === "deploy") return { code: 1 };
      return {};
    },
  );

  assert.equal(rec.repairs.length, 1, `no repair ran; events were ${JSON.stringify(rec.events).slice(0, 300)}`);
  assert.equal(rec.repairs[0].named, "cloudrun");
  assert.ok(rec.repairs[0].ranCloudRunDeploy, "a Cloud Run deploy is repaired on Cloud Run");
  assert.ok(!rec.repairs[0].placedAgain, "nothing may be placed on a node by a Cloud Run repair");
});

/** A one-service config, so `appConfig` exists and `declared` is the author's. */
const configWith = (service: Record<string, unknown>) => JSON.stringify({
  version: 1,
  services: [{ name: "web", dir: ".", path: "/", ...service }],
});

test("an app that declares scale deploys to the fleet and gets the size it asked for", NEEDS_MOCKS, async () => {
  // Two defects, one line apart.
  //
  // `assertReached`'s `scale` check read `o.argv` — which is `lastArgv`, assigned
  // only inside `attempt()`, which `runFleetDeploy` never calls. So argv was `[]`,
  // the check was false, and it THREW after the placement had already succeeded:
  // the app was live on the node, the outer catch wrote `status: failed`,
  // `markAppLive` never ran so `run_url` still pointed at the old address, and
  // the owner was told "That is a platform bug". Its neighbours `env`, `secrets`
  // and `uses` all short-circuit on `!hasRevision`; this one did not.
  //
  // And the check was right to be unhappy, for a reason it could not express:
  // `buildAppSpec` ignored the declared scale and placed 2 GiB / 1024 shares no
  // matter what the author wrote. Guarding the check without carrying the value
  // would have made the platform agree with itself and still not do what it was
  // told — an app that declares 4Gi because it OOMs at 2Gi would have been
  // OOM-killed on a deploy reporting success.
  const rec = await onFleet({
    "Dockerfile": "FROM alpine\n",
    "index.js": "",
    "supersonic.json": configWith({ scale: { memory: "4Gi", cpu: 2 } }),
  });

  const errors = rec.events.filter((e) => (e as { type?: string }).type === "error");
  assert.equal(errors.length, 0, `a successful fleet deploy was reported as failed: ${JSON.stringify(errors).slice(0, 500)}`);
  assert.equal(rec.placements.length, 1, `expected one placement, got ${rec.placements.length}`);
  const { spec } = rec.placements[0];
  assert.equal(spec.memoryBytes, 4 * 1024 * 1024 * 1024, "the node must be told the memory the author declared");
  assert.equal(spec.cpuShares, 2048, "the node must be told the CPU the author declared");
});

test("an app that declares no scale is placed at the platform's floor", NEEDS_MOCKS, async () => {
  // The floor exists because Cloud Run's 512Mi OOM-killed a real Node app at
  // 564Mi before it bound $PORT (see DEFAULT_SCALE). Carrying a declared scale
  // must not turn "undeclared" into "unset" and hand a node a zero.
  const rec = await onFleet({ "Dockerfile": "FROM alpine\n", "index.js": "" });
  assert.equal(rec.placements.length, 1);
  assert.equal(rec.placements[0].spec.memoryBytes, 2 * 1024 * 1024 * 1024);
  assert.equal(rec.placements[0].spec.cpuShares, 1024);
});

test("a fleet deploy of an app with a release records a release stage with a real outcome", NEEDS_MOCKS, async () => {
  // docs/research/cloud-run-shape.md: "release is a full architectural fork, not
  // a branch. On Cloud Run it's a named stage wrapping a Cloud Run Job... On the
  // fleet... it never runs as a separate stage at all... Consequence: fleet
  // deploys produce no release row in deploy_stages at all." `release` already
  // exists in LANE_KNOWN_STAGES — nothing writes it from this branch.
  //
  // A Procfile `release:` line is enough to prove it: readProcesses resolves it
  // to kind "release" with no `releaseCmd` involved at all, which is the same
  // channel buildAppSpec folds into the node's AppSpec at line ~3630.
  const rec = await onFleet({
    "Dockerfile": "FROM alpine\n",
    "Procfile": "web: node index.js\nrelease: node migrate.js\n",
    "index.js": "",
  });

  const errors = rec.events.filter((e) => (e as { type?: string }).type === "error");
  assert.equal(errors.length, 0, `a successful fleet deploy was reported as failed: ${JSON.stringify(errors).slice(0, 500)}`);

  const release = rec.stages.filter((s) => s.stage === "release");
  assert.equal(release.length, 1, `expected exactly one release stage, got ${JSON.stringify(rec.stages)}`);
  // Not a fake "ok" written regardless of what happened — the placement actually
  // came up, and coming up is proof the release the node ran before starting the
  // app's own processes did not fail (a failed release blocks the app forever).
  assert.equal(release[0].outcome, "ok", `a release that gated a successful placement must read ok, got ${JSON.stringify(release)}`);
});

test("a fleet deploy of an app with no release writes no release row", NEEDS_MOCKS, async () => {
  // The other half of the acceptance criteria, and the one silence would pass by
  // default: a fake "ok" for an app that declared no release is indistinguishable,
  // in deploy_stages, from a real one that happened to succeed — and a reliability
  // query over that table cannot tell them apart, which is exactly the lie this
  // ticket exists to refuse.
  const rec = await onFleet({ "Dockerfile": "FROM alpine\n", "index.js": "" });

  assert.ok(rec.placements.length > 0, "sanity: the deploy must actually place, or the absence of a release row proves nothing");
  assert.ok(
    !rec.stages.some((s) => s.stage === "release"),
    `an app with no release must write no release stage, got ${JSON.stringify(rec.stages)}`,
  );
});

test("a fleet placement that never comes up records its release as failed too", NEEDS_MOCKS, async () => {
  // The node blocks an app's own processes from starting at all until its
  // release succeeds (main.go's `blocked` map), so a placement that never
  // answers can never be evidence of a release that DID succeed — "ok" here
  // would be the fake success the acceptance criteria rules out. It is still
  // an approximation in the other direction (a release can succeed and the web
  // process can crash afterward, and this reads as a release failure too) — see
  // the comment beside where this is recorded for why that is the best available
  // signal without a node-side change, and why it is still better than the
  // silence this ticket closes.
  probeCode = 503;
  let rec: Recorded;
  try {
    rec = await onFleet({
      "Dockerfile": "FROM alpine\n",
      "Procfile": "web: node index.js\nrelease: node migrate.js\n",
      "index.js": "",
    });
  } finally {
    probeCode = 200;
  }

  const release = rec.stages.filter((s) => s.stage === "release");
  assert.equal(release.length, 1, `expected exactly one release stage, got ${JSON.stringify(rec.stages)}`);
  assert.equal(release[0].outcome, "failed", `a placement that never verified must not report its release as ok, got ${JSON.stringify(release)}`);
});

test("a sibling's Dockerfile is written for the context it is built in", { ...NEEDS_MOCKS, skip: !COLLAPSED }, async () => {
  // The bug that broke EVERY sibling, and it is invisible from argv alone: the
  // context was right and the file inside it was written for a different one.
  //
  // `deploySibling` roots the build context at the service's own directory and
  // then detected with `rel = svc.dir`, so every command came out wrapped as
  // `(cd api && …)` inside a context that IS api. `/app/api` does not exist, so
  // the first RUN failed — on every sibling, because a sibling by definition has
  // a directory of its own.
  //
  // Asserted by reading the file the build was actually handed, at the moment it
  // was handed over. The generated Dockerfile is the deliverable; a context path
  // says nothing about whether the thing inside it can build.
  const written = new Map<string, string>();
  const rec = await run(
    {
      "supersonic.json": JSON.stringify({
        version: 1,
        services: [
          { name: "web", dir: "web", language: "node", start: "node server.js", path: "/" },
          { name: "api", dir: "api", language: "python", start: "uvicorn main:app --host 0.0.0.0 --port $PORT", path: "/api" },
        ],
      }),
      "web/package.json": '{"scripts":{"start":"node server.js"}}',
      "web/server.js": "",
      "api/requirements.txt": "fastapi\nuvicorn\n",
      "api/main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
    },
    {},
    (argv) => {
      if (argv[1] === "builds" && argv[2] === "submit") {
        const df = join(argv[3], "Dockerfile");
        if (existsSync(df)) written.set(argv[3], readFileSync(df, "utf8"));
      }
      return detect()(argv);
    },
  );

  const api = [...written.entries()].find(([ctx]) => ctx.endsWith("/api"));
  assert.ok(api, `no Dockerfile was written for the api context; contexts were ${[...written.keys()].join(", ")}`);
  const [, dockerfile] = api!;

  // Nothing may reach outside the context it was written for.
  assert.doesNotMatch(dockerfile, /\(cd api &&/, "the context IS api — there is no api/ inside it");
  assert.doesNotMatch(dockerfile, /^WORKDIR \/app\/api$/m);
  // And the install it does emit is the one the directory's own manifest implies.
  assert.match(dockerfile, /^RUN pip install .*requirements\.txt$/m);

  assert.ok(rec.argv.some((a) => a[1] === "builds" && a[2] === "submit"), "the sibling never built");
});

/* -------------------------------------------------------------------------- */
/* One app, one runtime                                                       */
/* -------------------------------------------------------------------------- */

/** Did this deploy create a Cloud Run worker pool? */
const madeAWorkerPool = (rec: Recorded) =>
  rec.argv.some((a) => a[0] === "gcloud" && a[1] === "beta" && a[2] === "run" && a[3] === "worker-pools" && a[4] === "deploy");

test("an app on Cloud Run still gets its Cloud Run worker pool", NEEDS_MOCKS, async () => {
  // The control for the test below. Without this the next assertion is satisfied
  // by a pipeline that has simply stopped deploying workers altogether, which
  // would be a far worse bug than the one being fixed.
  const rec = await run(
    { "Dockerfile": "FROM alpine\n", "Procfile": "web: node index.js\nbot: node bot.js\n", "index.js": "" },
    {},
    detect(),
  );

  assert.ok(madeAWorkerPool(rec), `no worker pool was deployed off the fleet; argv was ${JSON.stringify(rec.argv.map((a) => a.slice(0, 5)))}`);
});

test("an app on the fleet does not ALSO run its workers on Cloud Run", NEEDS_MOCKS, async () => {
  // The defect this closes, and the reason it belongs in this slice. The
  // `deployProcesses` call was gated on `result.ok && !staticServe` with no
  // `toFleet` guard, and `planProcesses` emits a worker pool for every worker
  // and a job plus schedule for every cron. The SAME processes are already in
  // the placed spec and are started as sandboxes by the node.
  //
  // For a web app on the fleet those duplicates were the documented status quo.
  // For a WORKER-ONLY app the entire app would run twice — a Telegram bot
  // double-polling getUpdates, a queue consumer double-consuming — and the new
  // verdict would truthfully report the node running it while the Cloud Run copy
  // ran beside it. This slice is what first makes an app depend on the node
  // alone, so this is where the guard has to land.
  const rec = await onFleet({ "Dockerfile": "FROM alpine\n", "Procfile": "web: node index.js\nbot: node bot.js\n", "index.js": "" });

  assert.ok(rec.placements.length > 0, `nothing was placed; stages were ${rec.stages.map((s) => s.stage).join(", ")}`);
  // The node really was given the worker — otherwise "no Cloud Run worker" would
  // mean the worker is not running anywhere at all, which is the failure mode
  // this guard could most easily become.
  const placed = rec.placements.at(-1)!.spec.processes ?? [];
  assert.ok(placed.some((p) => p.name === "bot" && p.kind === "worker"),
    `the node was not given the worker, so removing the Cloud Run one loses it: ${JSON.stringify(placed)}`);
  assert.ok(!madeAWorkerPool(rec),
    `the app runs on the fleet AND deployed a Cloud Run worker pool — two live copies of one process`);
});

test("a worker-only app deploys to the fleet, verified by the node rather than by a probe", NEEDS_MOCKS, async () => {
  // The slice, end to end. `fleetEligibility` used to refuse every serviceless
  // app — "a worker-only app has no route to verify from the fleet yet" — and
  // that was never a fleet limitation; the fleet runs a bot better than Cloud
  // Run does. It was a limitation of the CHECK. The node now reports what it is
  // confirmed to be running, so there is a proof that does not need a route.
  //
  // The probe is forced to fail here, and the deploy must still succeed: that is
  // what proves the verdict came from the node's report and not from an HTTP
  // answer nothing should have been asking for.
  probeCode = 503;
  let rec: Recorded;
  try {
    rec = await onFleet({ "Dockerfile": "FROM alpine\n", "Procfile": "bot: node bot.js\n", "index.js": "" });
  } finally {
    probeCode = 200;
  }

  assert.equal(rec.placements.length, 1, `expected one placement, got ${rec.placements.length}`);
  const placed = rec.placements[0].spec.processes ?? [];
  assert.deepEqual(placed.map((p) => `${p.kind}:${p.name}`), ["worker:bot"]);
  const errors = rec.events.filter((e) => (e as { type?: string }).type === "error");
  assert.equal(errors.length, 0, `a worker-only fleet deploy failed: ${JSON.stringify(errors).slice(0, 400)}`);
  // And it is not double-run, which is the whole reason it is safe to ship.
  assert.ok(!madeAWorkerPool(rec), "the bot runs on the node AND on Cloud Run");
});

test("a deploy that goes to Cloud Run says so, so the node stops being handed the app", async () => {
  // The door nobody had closed. setRuntime was only ever called by placeOnFleet
  // and by its rollback, so an app that had been placed on the fleet and then
  // deployed to Cloud Run kept runtime='fleet' AND kept its placement row.
  // desiredFor yields every placement whose app reads 'fleet', so the node went
  // on running a second copy of an app Cloud Run was already serving.
  //
  // Seen on p6mx8 the moment it was withdrawn from the canary: Cloud Run served
  // it while fleet-lab-1 kept failing its release every few minutes.
  //
  // Asserted as a VALUE, not as "setRuntime was called": a stub that wrote
  // 'fleet' here would satisfy a membership check and reintroduce the bug.
  const rec = await run({ "Dockerfile": "FROM alpine\n", "index.js": "" }, {}, detect());

  assert.ok(
    rec.runtimeWrites.some((w) => w.runtime === "cloudrun"),
    `a Cloud Run deploy never wrote runtime=cloudrun: ${JSON.stringify(rec.runtimeWrites)}`,
  );
  assert.ok(
    !rec.runtimeWrites.some((w) => w.runtime === "fleet"),
    `a Cloud Run deploy claimed the fleet: ${JSON.stringify(rec.runtimeWrites)}`,
  );
});

/** Did the pipeline ask Cloud Run's domain-mapping API to map this app's name? */
const mappedADomain = (rec: Recorded) =>
  rec.argv.some((a) => a[0] === "gcloud" && a.includes("domain-mappings") && a.includes("create"));

test("a fleet deploy makes no domain-mapping call", NEEDS_MOCKS, async () => {
  // docs/research/cloud-run-shape.md's "the gap": `resources.ts`'s `domain`
  // resource has no runtime field, so a non-sealed, non-static fleet app fell
  // through to `createDomainMapping` against a Cloud Run service that was
  // deliberately never created for it. The call failed, was caught, and was
  // logged — on every such fleet deploy — which is exactly the kind of error
  // line that teaches everyone errors in these logs are normal.
  const rec = await onFleet({ "Dockerfile": "FROM alpine\n", "index.js": "" });

  assert.ok(!mappedADomain(rec), `a fleet deploy must never call Cloud Run's domain-mapping API: ${JSON.stringify(rec.argv.filter((a) => a.includes("domain-mappings")))}`);
  assert.ok(
    !rec.events.some((e) => JSON.stringify(e).includes("custom domain skipped")),
    "the dead call's log line must be gone, and nothing may replace it",
  );
});

test("a Cloud Run deploy still gets its domain mapping", NEEDS_MOCKS, async () => {
  // The other half — this removes a call on the fleet path, not the feature.
  const rec = await run({ "Dockerfile": "FROM alpine\n", "index.js": "" }, {}, detect());

  assert.ok(mappedADomain(rec), `a Cloud Run deploy must still map its domain: ${JSON.stringify(rec.argv.map((a) => a.slice(0, 4)))}`);
});
