import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fleetEligibility, fleetVerdict, fleetProbe, fleetPlacementWanted, placeOnFleet, chooseRuntime,
  specHasWeb, requiredProcesses, runVerdict, awaitRunning, type PlacementPorts,
} from "../lib/fleet-place";
import { buildAppSpec, type AppSpec } from "../lib/fleet-spec";
import { resolveProcess } from "../lib/processes";
import type { ProcessState } from "../lib/fleet";
import type { Lane } from "../lib/lanes";
import { classify } from "../lib/deploy-errors";

const spec: AppSpec = {
  slug: "myapp",
  image: "us-central1-docker.pkg.dev/p/r/myapp:latest",
  port: 8080,
  memoryBytes: 2147483648,
  cpuShares: 1024,
  healthPath: "/",
};

/**
 * A worker-only placement, built by the thing that builds the real ones.
 *
 * Hand-writing the AppSpec would prove that this file and `runVerdict` share an
 * imagination. Everything the verdict compares is produced here by the pipeline's
 * own resolver and translator — `resolveProcess` decides the kind, `buildAppSpec`
 * wraps the command in `/bin/sh -c` via shellArgv — so a change to either shows up
 * as a failing test rather than as a worker-only deploy that rolls back for a
 * reason nobody can act on.
 */
function workerOnlySpec(command = "python bot.py"): AppSpec {
  return buildAppSpec({
    slug: "myapp",
    image: "us-central1-docker.pkg.dev/p/r/myapp@sha256:abc",
    env: [], secrets: [],
    processes: [resolveProcess("bot", { command })],
  });
}

/**
 * What the node reports for a spec it is faithfully running.
 *
 * Derived from the spec rather than typed out, and that is the point: it mirrors
 * `reportRunning` in services/fleet/agent/main.go field for field — slug from the
 * app, process from the process's own name, image from the app, command from the
 * process — so the strings the two sides key on cannot drift apart here without
 * the Go side's own tests or the drift test in fleet-spec.test.ts catching it.
 */
function reportFor(s: AppSpec): ProcessState[] {
  return requiredProcesses(s).map((p) => ({
    slug: s.slug, process: p.name, image: s.image, command: p.command,
  }));
}

/** Ports that record what was done, so the ORDER can be asserted. */
function ports(over: Partial<PlacementPorts> = {}) {
  const calls: string[] = [];
  const base: PlacementPorts = {
    chooseNode: async () => { calls.push("chooseNode"); return "fleet-lab-1"; },
    placeApp: async (slug, node, s) => { calls.push(`place:${slug}@${node}:${s.image}`); },
    unplaceApp: async (slug) => { calls.push(`unplace:${slug}`); },
    readPlacement: async () => { calls.push("read"); return null; },
    readRuntime: async () => { calls.push("readRuntime"); return "fleet"; },
    setRuntime: async (slug, rt) => { calls.push(`runtime:${slug}=${rt}`); },
    probe: async () => { calls.push("probe"); return { code: 200 }; },
    runningOnNode: async () => { calls.push("running"); return { ok: true }; },
    nodeFaultFor: async () => { calls.push("nodeFault"); return null; },
    // The release ports, defaulted so every test keeps its shape — and REQUIRED
    // on the interface, which is what stops a future call site placing an app
    // and recording nothing about what it placed.
    readDesired: async () => null,
    recordRelease: async () => 1,
    setDesired: async () => {},
    log: () => {},
  };
  return { calls, p: { ...base, ...over } };
}

// `lane` is widened to `Lane` (not narrowed to the literal "container") so the
// override cases below — which swap in "runner" — typecheck against
// `Partial<typeof eligible>`.
const eligible = { lane: "container" as Lane, image: "img", staticServe: false, serviceless: false, hasDockerfile: false, workers: 0 };

/** A worker-only app that IS placeable: one long-running process, and a Dockerfile. */
const eligibleWorker = { ...eligible, serviceless: true, workers: 1, hasDockerfile: true };

test("an app with a database goes to the fleet now that a node has a proxy", () => {
  // The refusal added on 2026-08-04 was a guard for exactly one gap: the fleet
  // had no equivalent of Cloud Run's sidecar. A node runs one now, on the
  // bridge gateway, so the guard is what is wrong.
  assert.equal(chooseRuntime(eligible).runtime, "fleet");
});

test("what the fleet cannot serve is named, and goes to Cloud Run", () => {
  const cases: Array<[Partial<typeof eligible>, RegExp]> = [
    [{ staticServe: true }, /static/i],
    [{ lane: "runner" }, /runner/i],
    [{ lane: "buildpack" }, /buildpack/i],
    [{ image: "" }, /image/i],
    // Serviceless with no worker is a CRON-ONLY app, and it is refused for a
    // reason that survived the change: a cron sandbox is never in the agent's
    // live set, so no node could report it running.
    [{ serviceless: true }, /long-running|schedule/i],
  ];
  for (const [over, why] of cases) {
    const r = chooseRuntime({ ...eligible, ...over });
    assert.equal(r.runtime, "cloudrun", `${JSON.stringify(over)} should stay on Cloud Run`);
    assert.match(r.reason!, why);
  }
});

test("a placeable app is given no reason, because there is nothing to explain", () => {
  assert.equal(chooseRuntime(eligible).reason, undefined);
});

test("a worker-only app can be placed on the fleet now that the node reports what it runs", () => {
  // The refusal this replaces said the fleet had no way to VERIFY a worker: the
  // only proof accepted was an HTTP answer through the load balancer, and a bot
  // publishes no route to ask. That was never a fleet limitation — the fleet
  // runs a bot better than Cloud Run does — and the node now reports the
  // processes it is confirmed to be running, so the proof exists.
  const r = fleetEligibility(eligibleWorker);
  assert.equal(r.ok, true, `a worker-only app was refused: ${r.reason}`);
  assert.equal(chooseRuntime(eligibleWorker).runtime, "fleet");
});

test("a cron-only app is still refused, because nothing about it is ever running", () => {
  // The distinction the whole verdict rests on. A cron process is never in the
  // agent's live set — `units` in reconcileOnce excludes it, because the
  // scheduler owns it — so the node would report no rows and every deploy of a
  // correctly-configured app would roll back.
  const r = fleetEligibility({ ...eligibleWorker, workers: 0 });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /long-running|schedule/i);
});

test("a serviceless app whose `workers` never arrived is refused, not placed", () => {
  // Not hypothetical, and not a type error either: nothing in this repo
  // typechecks the tests — the test command is `node --import tsx --test` and
  // there is no typecheck script — so a caller that forgets this field ships.
  // `workers === 0` would be FALSE for undefined and place a cron-only app on a
  // node that can never confirm it. Asked the way a caller who forgot would ask.
  const missing = { ...eligibleWorker } as Partial<typeof eligibleWorker>;
  delete missing.workers;
  const r = fleetEligibility(missing as typeof eligibleWorker);
  assert.equal(r.ok, false, "an app with no `workers` count at all was declared placeable");
  assert.match(r.reason!, /long-running|schedule/i);
});

test("a worker-only app with no Dockerfile is refused, because `--pack` built its image", () => {
  // Stated directly rather than left to the lane label. What actually selects
  // that builder is `useDockerBuild = hasDockerfileNow` in the pipeline, not the
  // lane — they agree today only because `laneFor` happens to make them, which
  // makes the guarantee contingent on a file in another module. That submit
  // writes no cloudbuild.yaml, so it has no logging destination and runs as the
  // default build account, and it names the image before anything built it.
  const r = fleetEligibility({ ...eligibleWorker, hasDockerfile: false });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /Dockerfile|pack/i);
});

test("one app can be moved before the default does", () => {
  // The same shape as BUILDKIT_APPS, for the same reason: main deploys straight
  // to production, so the only way to prove a new path on real traffic is to
  // prove it on ONE app first. The spec now carries env and secrets and no app
  // has ever been placed with those fields — that is exactly what a canary is for.
  assert.equal(fleetPlacementWanted({ FLEET_PLACEMENT: "1" }, "anything"), true);
  assert.equal(fleetPlacementWanted({ FLEET_APPS: "avkf5, a8ebb" }, "a8ebb"), true);
  assert.equal(fleetPlacementWanted({ FLEET_APPS: "avkf5" }, "a8ebb"), false);
  assert.equal(fleetPlacementWanted({}, "a8ebb"), false);
});

test("a static app is not placeable, and the reason says why", () => {
  const r = fleetEligibility({ ...eligible, staticServe: true });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /static/i);
});

test("a runner-lane app is not placeable — its image is not its own", () => {
  // The runner lane runs a shared prebuilt image and delivers the customer's
  // code as an encrypted bundle. A node given that image would start the runner,
  // not the app. This is one of the 19 that stayed behind, and it is not a bug
  // to fix here: it is the lane that is being deleted.
  const r = fleetEligibility({ ...eligible, lane: "runner" });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /runner/i);
});

test("an app whose build produced no image is not placeable", () => {
  const r = fleetEligibility({ ...eligible, image: "" });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /image/i);
});

test("a buildpack app is not placeable — its image is made by the deploy it is skipping", () => {
  // This lane used to be allowed here, and was kept off the fleet only by
  // `image: ""` — the pipeline has no name for a buildpack image at decision
  // time, because `run deploy --source` builds it and Cloud Run names it. That
  // is an accident, not a decision: give the lane a deterministic tag and it
  // becomes eligible again, and what it would place is an image no build in
  // this deploy produced. The fleet branch runs no `--source`, so there is
  // nothing to hand a node, and the refusal now says which.
  const r = fleetEligibility({ ...eligible, lane: "buildpack" });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /buildpack/i);
  // …and it stays refused even when an image name IS supplied, which is the
  // whole point of naming it rather than leaning on the empty-image check.
  assert.equal(fleetEligibility({ ...eligible, lane: "buildpack", image: "img" }).ok, false);
});

test("a buildpack-lane app that has a Dockerfile is placeable", () => {
  // The lane is fixed before the pipeline writes the SPA and Next.js fallback
  // Dockerfiles, so an app can carry lane "buildpack" and still build a normal
  // image with a resolvable digest. Refusing it reads the label instead of the
  // fact next to it.
  const got = fleetEligibility({
    lane: "buildpack",
    image: "us-central1-docker.pkg.dev/p/r/x@sha256:abc",
    staticServe: false,
    serviceless: false,
    hasDockerfile: true,
    workers: 0,
  });
  assert.equal(got.ok, true, `refused a real image: ${got.ok ? "" : got.reason}`);
});

test("a buildpack-lane app with no Dockerfile is still refused, and says why", () => {
  // This is the genuine case: `gcloud run deploy --source` builds it and Cloud
  // Run names the result, so at decision time there is no reference to hand a
  // node.
  const got = fleetEligibility({
    lane: "buildpack",
    image: "",
    staticServe: false,
    serviceless: false,
    hasDockerfile: false,
    workers: 0,
  });
  assert.equal(got.ok, false);
  if (!got.ok) assert.match(got.reason!, /buildpack|source/i);
});

test("a Dockerfile does not rescue the lanes refused for other reasons", () => {
  // Each of these is refused for something a Dockerfile does not change: a
  // static app has no image of its own, the runner's image is shared and the
  // app's code is not in it, and a cron-only app has nothing a node could ever
  // report as running. The serviceless case used to sit here for a fourth reason
  // — no route to probe — and a Dockerfile did not change that one either. It is
  // gone because the reason is gone, not because the rule weakened.
  for (const c of [
    { lane: "static" as const, staticServe: true, serviceless: false, workers: 0 },
    { lane: "runner" as const, staticServe: false, serviceless: false, workers: 0 },
    { lane: "container" as const, staticServe: false, serviceless: true, workers: 0 },
  ]) {
    const got = fleetEligibility({
      lane: c.lane,
      image: "us-central1-docker.pkg.dev/p/r/x@sha256:abc",
      staticServe: c.staticServe,
      serviceless: c.serviceless,
      hasDockerfile: true,
      workers: c.workers,
    });
    assert.equal(got.ok, false, `${c.lane} was wrongly allowed by a Dockerfile`);
  }
});

test("no image is still no image, Dockerfile or not", () => {
  // `hasDockerfile` says how it WOULD be built; `image` says what this deploy
  // actually produced. An empty image must still refuse — placing a tag nobody
  // built is the mistake the digest work exists to stop.
  const got = fleetEligibility({
    lane: "container",
    image: "",
    staticServe: false,
    serviceless: false,
    hasDockerfile: true,
    workers: 0,
  });
  assert.equal(got.ok, false);
});

test("a container app with an image is placeable", () => {
  assert.equal(fleetEligibility(eligible).ok, true);
});

test("the router answering is not the app answering", () => {
  // The trap migrate.sh documents: a routing miss returns 404, and so does an
  // app whose root path is undefined. Without reading X-Supersonic-Router the
  // check passes an app that is not running at all — and then run_url is flipped
  // to a fleet that is serving nothing.
  assert.equal(fleetVerdict({ code: 404, router: "miss" }).ok, false);
  assert.equal(fleetVerdict({ code: 404 }).ok, true);
  assert.equal(fleetVerdict({ code: 302 }).ok, true);
  assert.equal(fleetVerdict({ code: 500 }).ok, false);
  assert.equal(fleetVerdict({ code: 0 }).ok, false);
});

/** A fetch that answers from a script, and counts how often it was asked. */
function scriptedFetch(steps: Array<{ status: number; router?: string } | "throw">) {
  const seen: string[] = [];
  let i = 0;
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    const step = steps[Math.min(i++, steps.length - 1)];
    seen.push(String((init?.headers as Record<string, string>)?.["x-supersonic-slug"] ?? ""));
    if (step === "throw") throw new Error("connect ECONNREFUSED");
    return {
      status: step.status,
      headers: { get: (h: string) => (h.toLowerCase() === "x-supersonic-router" ? step.router ?? null : null) },
    } as unknown as Response;
  };
  return { impl: impl as unknown as typeof fetch, seen, count: () => i };
}

test("an app that needs a moment to come up is waited for", async () => {
  // A sandbox does not serve the instant it is placed. migrate.sh gave this 24
  // attempts for a reason, and a single-shot probe would roll back healthy apps
  // for being slow — the most expensive kind of false negative here, because it
  // looks exactly like the fleet not working.
  const f = scriptedFetch([{ status: 404, router: "miss" }, { status: 404, router: "miss" }, { status: 200 }]);
  const r = await fleetProbe("8.232.255.172", "myapp", { fetchImpl: f.impl, attempts: 6, delayMs: 0 });

  assert.deepEqual(r, { code: 200, router: undefined });
  assert.equal(f.count(), 3);
  // Addressed by header, the way the edge proxy addresses it — not by Host.
  assert.deepEqual(f.seen, ["myapp", "myapp", "myapp"]);
});

test("a refused connection is not an answer, and is not a 200 either", async () => {
  const f = scriptedFetch(["throw"]);
  const r = await fleetProbe("8.232.255.172", "myapp", { fetchImpl: f.impl, attempts: 2, delayMs: 0 });

  assert.equal(r.code, 0);
  assert.equal(fleetVerdict(r).ok, false);
});

test("a router that never stops saying miss is given up on, not waited on forever", async () => {
  const f = scriptedFetch([{ status: 404, router: "miss" }]);
  const r = await fleetProbe("8.232.255.172", "myapp", { fetchImpl: f.impl, attempts: 3, delayMs: 0 });

  assert.equal(f.count(), 3);
  assert.equal(fleetVerdict(r).ok, false);
});

test("a full fleet leaves the app on Cloud Run instead of losing it", () => {
  // chooseNode returning null had no handler anywhere. Unhandled, this is an app
  // placed on the node named `null` — or a crash in the middle of a deploy that
  // has already succeeded.
  return (async () => {
    const { calls, p } = ports({ chooseNode: async () => null });
    const r = await placeOnFleet("myapp", spec, "8.232.255.172", p);

    assert.equal(r.placed, false);
    assert.match(r.reason!, /no node/i);
    // Nothing was written. The app is exactly where the deploy left it.
    assert.deepEqual(calls.filter((c) => !c.startsWith("chooseNode")), []);
  })();
});

test("a version that does not answer is replaced by the one that did, on the node it was already on", async () => {
  // The previous placement is on fleet-lab-2, a DIFFERENT node than the one
  // this deploy's chooseNode hands back (fleet-lab-1). placeApp upserts on
  // (slug, node), so restoring onto fleet-lab-1 instead of fleet-lab-2 would
  // write a second row rather than putting back the one that was overwritten
  // — this is the test that catches that mistake; a membership check on
  // "was placeApp called with the right image" cannot see which node it went to.
  const { calls, p } = ports({
    probe: async () => { calls.push("probe"); return { code: 502 }; },
    readPlacement: async () => {
      calls.push("read");
      return { node: "fleet-lab-2", spec: { ...spec, image: "registry/myapp:good" } };
    },
  });
  const r = await placeOnFleet("myapp", { ...spec, image: "registry/myapp:bad" }, "8.232.255.172", p);

  assert.equal(r.placed, false);
  assert.equal(r.runUrl, undefined);
  // The full ordered sequence, not just membership: it proves the read
  // happened BEFORE the place that overwrites it (a read taken afterward would
  // see the broken spec and "restore" it over itself) and that the restore
  // lands on fleet-lab-2, not fleet-lab-1.
  assert.deepEqual(calls, [
    "chooseNode",
    "read",
    "readRuntime",
    "place:myapp@fleet-lab-1:registry/myapp:bad",
    "runtime:myapp=fleet",
    "probe",
    // The node is asked whose failure this was before anything is restored, so
    // the log line the operator reads carries the answer too.
    "nodeFault",
    "place:myapp@fleet-lab-2:registry/myapp:good",
    "runtime:myapp=fleet",
  ]);
  // And nothing goes to Cloud Run. There is no way back any more.
  assert.ok(!calls.some((c) => c.includes("cloudrun")), "an app was sent back to Cloud Run");
});

test("a first deploy that fails is unplaced rather than restored to nothing, and the runtime flag goes back with it", async () => {
  // No previous placement exists, so there is nothing to put back — the app
  // must not be left pointing at a version that does not serve. The runtime
  // flag was only flipped to 'fleet' so the probe below had something to
  // check; a first deploy's real previous runtime is 'cloudrun' (the default
  // for an app that has never been placed), and that is what must come back —
  // asserted as a value, not just that setRuntime was called at all, because a
  // stub that always restores 'fleet' would pass a call-membership check.
  const { calls, p } = ports({
    probe: async () => { calls.push("probe"); return { code: 0 }; },
    readPlacement: async () => { calls.push("read"); return null; },
    readRuntime: async () => { calls.push("readRuntime"); return "cloudrun"; },
  });
  const r = await placeOnFleet("myapp", spec, "8.232.255.172", p);

  assert.equal(r.placed, false);
  assert.deepEqual(calls, [
    "chooseNode",
    "read",
    "readRuntime",
    `place:myapp@fleet-lab-1:${spec.image}`,
    "runtime:myapp=fleet",
    "probe",
    "nodeFault",
    "unplace:myapp",
    "runtime:myapp=cloudrun",
  ]);
});

test("place and verify, and only then is there an address to publish", async () => {
  const { calls, p } = ports();
  const r = await placeOnFleet("myapp", spec, "8.232.255.172", p);

  assert.equal(r.placed, true);
  assert.equal(r.node, "fleet-lab-1");
  // The flip is the caller's single write of run_url, and this is the only way
  // to obtain the address for it. Returning it rather than writing it is what
  // keeps run_url with ONE writer: markAppLive would otherwise overwrite a flip
  // made here with the Cloud Run url it was already carrying.
  assert.equal(r.runUrl, "http://8.232.255.172");
  assert.deepEqual(calls, ["chooseNode", "read", "readRuntime", "place:myapp@fleet-lab-1:" + spec.image, "runtime:myapp=fleet", "probe"]);
});

test("the probe asks the path the app said to ask", async () => {
  // A 200 at the root proves a process started. epvmx proved a started process
  // can refuse every real request, and an app whose database is unreachable
  // serves its homepage perfectly happily — which is the exact failure this
  // whole piece of work is about not shipping.
  const seen: string[] = [];
  const impl = (async (url: string) => {
    seen.push(String(url));
    return { status: 200, headers: { get: () => null } } as unknown as Response;
  }) as unknown as typeof fetch;

  await fleetProbe("8.232.255.172", "myapp", { fetchImpl: impl, attempts: 1, delayMs: 0, path: "/healthz" });
  assert.deepEqual(seen, ["http://8.232.255.172/healthz"]);
});

test("no declared path means the root, which is what every app has", async () => {
  const seen: string[] = [];
  const impl = (async (url: string) => {
    seen.push(String(url));
    return { status: 200, headers: { get: () => null } } as unknown as Response;
  }) as unknown as typeof fetch;

  await fleetProbe("8.232.255.172", "myapp", { fetchImpl: impl, attempts: 1, delayMs: 0 });
  assert.deepEqual(seen, ["http://8.232.255.172/"]);
});

/** Records the headers the probe actually sent, which is the whole assertion. */
function recordingFetch(sent: Record<string, string>[]) {
  return (async (_url: string, init: RequestInit) => {
    sent.push({ ...(init.headers as Record<string, string>) });
    return { status: 200, headers: { get: () => null } } as unknown as Response;
  }) as unknown as typeof fetch;
}

test("the probe signs itself when the deploy job has the secret", async () => {
  // Without this, enforcement makes the fleet UNDEPLOYABLE: the node answers an
  // unsigned probe 403 with X-Supersonic-Router: unsigned, fleetVerdict reads
  // the marker as "the router answered, not the app", placeOnFleet rolls the
  // placement back and every deploy fails. Trimmed, because the secret arrives
  // from Secret Manager and a newline in a header value throws.
  const sent: Record<string, string>[] = [];
  process.env.FLEET_EDGE_SECRET = "  test-only-edge-secret-do-not-log \n";
  try {
    await fleetProbe("8.232.255.172", "myapp", { fetchImpl: recordingFetch(sent), attempts: 1, delayMs: 0 });
  } finally {
    delete process.env.FLEET_EDGE_SECRET;
  }
  assert.equal(sent[0]["x-supersonic-edge"], "test-only-edge-secret-do-not-log");
  assert.equal(sent[0]["x-supersonic-slug"], "myapp");
});

test("with no secret the probe sends none, which is how the rollout bootstraps", async () => {
  // The same property the router and the proxy have: before the secret exists
  // anywhere, nothing signs and nothing enforces, so the three deploys need not
  // be simultaneous.
  const sent: Record<string, string>[] = [];
  delete process.env.FLEET_EDGE_SECRET;
  await fleetProbe("8.232.255.172", "myapp", { fetchImpl: recordingFetch(sent), attempts: 1, delayMs: 0 });
  assert.equal("x-supersonic-edge" in sent[0], false);
  assert.equal(sent[0]["x-supersonic-slug"], "myapp");
});

test("a node that blames itself keeps the repair agent away", async () => {
  // The whole plan is this test. The probe sees silence at the load balancer,
  // which is what an app crash and a dead node proxy look like from outside;
  // the node knows which, and says so. classify() reads FLEET_NODE_FAULT as a
  // platform marker, which rolls back and tells the user without ever reaching
  // opencodeRepair — an LLM with write access to the customer's repository,
  // up to 18 steps and 3 rebuild-and-deploy cycles, over an outage we caused.
  const { calls, p } = ports({
    probe: async () => { calls.push("probe"); return { code: 0 }; },
    nodeFaultFor: async () => {
      calls.push("nodeFault");
      return { node: "fleet-lab-1", detail: "this node's database path (10.200.0.1:5432) is not answering" };
    },
  });
  const r = await placeOnFleet("myapp", spec, "8.232.255.172", p);

  assert.equal(r.placed, false);
  assert.match(r.reason ?? "", /FLEET_NODE_FAULT/);
  // Named, so the operator knows which machine to go and look at, and carrying
  // the node's own words rather than a summary of them.
  assert.match(r.reason ?? "", /fleet-lab-1/);
  assert.match(r.reason ?? "", /10\.200\.0\.1:5432/);
  // …and this is the assertion that makes the test worth having: the marker
  // has to survive the trip through classify, not merely appear in a string.
  assert.equal(classify(r.reason ?? "").blame, "platform");
});

test("a failure the node does NOT claim still reads as the app's", async () => {
  // The whole value is in this direction too: a node that took the blame for
  // everything would hide real app bugs behind a platform verdict, and the
  // repair agent exists because most failures really are the app's.
  const { calls, p } = ports({
    probe: async () => { calls.push("probe"); return { code: 502 }; },
    nodeFaultFor: async () => { calls.push("nodeFault"); return null; },
  });
  const r = await placeOnFleet("myapp", spec, "8.232.255.172", p);

  assert.equal(r.placed, false);
  assert.ok(!(r.reason ?? "").includes("FLEET_NODE_FAULT"));
  assert.match(r.reason ?? "", /502/);
  assert.notEqual(classify(r.reason ?? "").blame, "platform");
});

test("a node fault does not stop the deploy rolling back", async () => {
  // Blaming the platform decides who gets told, never what gets restored. The
  // previous version must go back on the node it was already on, and the
  // runtime flag with it, exactly as it does for an app fault — the ordered
  // sequence is asserted because a membership check cannot see that the
  // restore landed on fleet-lab-2 rather than this deploy's own node.
  const { calls, p } = ports({
    probe: async () => { calls.push("probe"); return { code: 0 }; },
    readPlacement: async () => {
      calls.push("read");
      return { node: "fleet-lab-2", spec: { ...spec, image: "registry/myapp:good" } };
    },
    readRuntime: async () => { calls.push("readRuntime"); return "cloudrun"; },
    nodeFaultFor: async () => { calls.push("nodeFault"); return { node: "fleet-lab-1", detail: "proxy down" }; },
  });
  const r = await placeOnFleet("myapp", { ...spec, image: "registry/myapp:bad" }, "8.232.255.172", p);

  assert.equal(r.placed, false);
  assert.deepEqual(calls, [
    "chooseNode",
    "read",
    "readRuntime",
    "place:myapp@fleet-lab-1:registry/myapp:bad",
    "runtime:myapp=fleet",
    "probe",
    "nodeFault",
    "place:myapp@fleet-lab-2:registry/myapp:good",
    "runtime:myapp=cloudrun",
  ]);
});

test("a fault lookup that throws does not swallow the rollback", async () => {
  // This port is a database call inside the one branch that must always
  // restore. An exception escaping placeOnFleet here would leave the broken
  // spec placed and the runtime flag on 'fleet' — the deploy failing in the one
  // way this whole sequence exists to prevent. Not being able to READ a fault
  // is simply not corroboration.
  const { calls, p } = ports({
    probe: async () => { calls.push("probe"); return { code: 0 }; },
    nodeFaultFor: async () => { calls.push("nodeFault"); throw new Error("connection terminated unexpectedly"); },
  });
  const r = await placeOnFleet("myapp", spec, "8.232.255.172", p);

  assert.equal(r.placed, false);
  assert.ok(!(r.reason ?? "").includes("FLEET_NODE_FAULT"));
  assert.ok(calls.includes("unplace:myapp"), "the placement was not rolled back");
  assert.ok(calls.includes("runtime:myapp=fleet"));
});

test("a port that is not wired at all cannot take the rollback with it", async () => {
  // Not a hypothetical: this is how the case above was found. A missing port
  // throws a TypeError SYNCHRONOUSLY — there is no promise yet, so a `.catch()`
  // on the call would never see it, the exception would escape placeOnFleet,
  // and the broken spec would stay placed with the runtime flag still on
  // 'fleet'. Asked the way a caller who forgot the port would ask it.
  const { calls, p } = ports({
    probe: async () => { calls.push("probe"); return { code: 0 }; },
  });
  delete (p as Partial<PlacementPorts>).nodeFaultFor;
  const r = await placeOnFleet("myapp", spec, "8.232.255.172", p as PlacementPorts);

  assert.equal(r.placed, false);
  assert.ok(!(r.reason ?? "").includes("FLEET_NODE_FAULT"));
  assert.ok(calls.includes("unplace:myapp"), "the placement was not rolled back");
});

test("a node fault with nothing to add does not trail an empty dash", async () => {
  // detail is optional — an unclassified fault withholds its text entirely, and
  // coalesce('') is what reaches here for a row that never had one.
  const { calls, p } = ports({
    probe: async () => { calls.push("probe"); return { code: 0 }; },
    nodeFaultFor: async () => { calls.push("nodeFault"); return { node: "fleet-lab-1", detail: "" }; },
  });
  const r = await placeOnFleet("myapp", spec, "8.232.255.172", p);

  assert.match(r.reason ?? "", /FLEET_NODE_FAULT/);
  assert.ok(!/—\s*$/.test(r.reason ?? ""), `reason ends in a dangling dash: ${r.reason}`);
});

// --- verifying an app that has no route -------------------------------------

test("which proof a placement needs is decided by whether the app serves HTTP", () => {
  // The branch everything below turns on, and the case that would break every
  // app on the platform if it went the wrong way: a spec with NO processes is
  // not worker-only. It is an ordinary app whose start command is its web
  // process under an older spelling, and `processesOf` synthesises exactly one
  // web process for it. Reading absent as "no web" would send every app that
  // predates the process model down the report path, where it has no rows and
  // no deploy could ever pass.
  assert.equal(specHasWeb(spec), true, "an app with no declared processes was treated as worker-only");
  assert.equal(specHasWeb(workerOnlySpec()), false);
  assert.equal(specHasWeb({ ...spec, processes: [{ name: "web", kind: "web" }] }), true);
  assert.equal(specHasWeb({ ...spec, processes: [{ name: "api", kind: "web" }, { name: "bot", kind: "worker" }] }), true);
});

test("only the processes a node actually keeps running are required of it", () => {
  // Mirrors the agent's `units`: a release runs once and is then gone, and a
  // cron is owned by the scheduler and never enters the live set at all.
  // Requiring either would require a row the node can never send, and every
  // deploy of an app with a migration would roll back.
  const withAll = buildAppSpec({
    slug: "myapp", image: "img", env: [], secrets: [],
    processes: [
      resolveProcess("bot", { command: "python bot.py" }),
      resolveProcess("nightly", { command: "python export.py", schedule: "0 3 * * *" }),
    ],
    releaseCommand: "python manage.py migrate",
  });
  // The producer really did put all three in the spec — otherwise this test
  // proves nothing about filtering.
  assert.deepEqual(withAll.processes?.map((p) => p.kind).sort(), ["cron", "release", "worker"]);
  assert.deepEqual(requiredProcesses(withAll).map((p) => p.name), ["bot"]);
});

test("a node running exactly what was placed is the verdict that passes", () => {
  const s = workerOnlySpec();
  const v = runVerdict(s, reportFor(s));
  assert.equal(v.ok, true, `a faithful report was rejected: ${v.reason}`);
});

test("silence from the node is not a pass", () => {
  // The whole reason this slice exists. `a.faults` is written only when a start
  // FAILS, so "nothing failing" is also what a node says about a process it has
  // not fetched yet — and absence-plus-time would flip run_url onto a node that
  // never started the bot.
  const s = workerOnlySpec();
  assert.equal(runVerdict(s, []).ok, false);
  assert.match(runVerdict(s, []).reason!, /not reporting/i);
  // A row for a DIFFERENT process of the same app is not a row for this one.
  assert.equal(runVerdict(s, [{ slug: "myapp", process: "other", image: s.image }]).ok, false);
});

test("the node running the PREVIOUS image is not this deploy having landed", () => {
  // The first read happens while the node may not have fetched the new
  // placement, and the previous deploy's rows are still there and still fresh —
  // `reported_at` is refreshed on every sync. Without the image in the
  // comparison this passes instantly, on the old process.
  const s = workerOnlySpec();
  const stale = reportFor(s).map((r) => ({ ...r, image: "us-central1-docker.pkg.dev/p/r/myapp@sha256:old" }));
  const v = runVerdict(s, stale);
  assert.equal(v.ok, false);
  assert.match(v.reason!, /different image/i);
});

test("the node running the PREVIOUS command at the same image is not it either", () => {
  // The half an image comparison cannot see, and it is not a corner case: an
  // author editing a Procfile line redeploys the same digest with a different
  // argv. The agent restarts on EITHER changing (`l.app.Image != u.app.Image ||
  // !sameStrings(...)`), so a verdict checking only the image claims to be the
  // node's own predicate and is weaker than it.
  const s = workerOnlySpec("python bot.py --new-flag");
  const previous = reportFor(workerOnlySpec("python bot.py"));
  // Same image, different command — otherwise this test is the one above.
  assert.equal(previous[0].image, s.image);
  assert.notDeepEqual(previous[0].command, requiredProcesses(s)[0].command);

  const v = runVerdict(s, previous);
  assert.equal(v.ok, false, "a worker still running the old command verified the new deploy");
  assert.match(v.reason!, /different command/i);
});

test("a placement with nothing long-running to confirm is not vacuously true", () => {
  // "Everything I required is running" is trivially true of nothing, which is
  // the shape a check quietly becomes when the thing it checks is refactored out
  // from under it. Unreachable through `fleetEligibility` today, and that is
  // exactly why it is worth pinning.
  const cronOnly = buildAppSpec({
    slug: "myapp", image: "img", env: [], secrets: [],
    processes: [resolveProcess("nightly", { command: "python export.py", schedule: "0 3 * * *" })],
  });
  assert.deepEqual(requiredProcesses(cronOnly), []);
  assert.equal(runVerdict(cronOnly, []).ok, false);
});

test("the first question is asked after a reconcile interval, not before one", async () => {
  // `fleetProbe` asks at t≈0 because an HTTP answer at t=0 is still an answer
  // from the app. A REPORT at t=0 is not: the node polls every ten seconds, so
  // nothing it has said yet can be about a placement written moments ago, and
  // the rows sitting there are the previous deploy's.
  const s = workerOnlySpec();
  const order: string[] = [];
  const v = await awaitRunning("myapp", "fleet-lab-1", s,
    async () => { order.push("read"); return reportFor(s); },
    { attempts: 3, delayMs: 5000, sleepImpl: async (ms) => { order.push(`sleep:${ms}`); } });

  assert.equal(v.ok, true);
  assert.deepEqual(order, ["sleep:5000", "read"]);
});

test("an app that needs a moment to come up on the node is waited for", async () => {
  // The same false negative `fleetProbe` retries against: a worker does not
  // appear in the node's report the instant it is placed — the node has to fetch
  // the placement, pull the image and start the sandbox, and only then does a
  // pass confirm it.
  const s = workerOnlySpec();
  let asked = 0;
  const v = await awaitRunning("myapp", "fleet-lab-1", s,
    async () => (++asked < 3 ? [] : reportFor(s)),
    { attempts: 6, delayMs: 0, sleepImpl: async () => {} });

  assert.equal(v.ok, true);
  assert.equal(asked, 3);
});

test("a node that never reports the app is given up on, and the deploy fails", async () => {
  const s = workerOnlySpec();
  let asked = 0;
  const v = await awaitRunning("myapp", "fleet-lab-1", s,
    async () => { asked++; return []; },
    { attempts: 4, delayMs: 0, sleepImpl: async () => {} });

  assert.equal(asked, 4);
  assert.equal(v.ok, false, "a worker that never came up passed its deploy");
});

test("a reader that throws becomes a failed verdict, never an escaped exception", async () => {
  // Same rule as `fleetProbe` swallowing a refused connection: this is a
  // database call inside the one sequence that must always restore, and an
  // exception thrown out of here would skip the restore of the previous
  // placement and the runtime flag.
  const s = workerOnlySpec();
  const v = await awaitRunning("myapp", "fleet-lab-1", s,
    async () => { throw new Error("connection terminated unexpectedly"); },
    { attempts: 2, delayMs: 0, sleepImpl: async () => {} });

  assert.equal(v.ok, false);
  assert.match(v.reason!, /could not read/i);
});

test("a worker-only app is verified by the node's report, and never probed", async () => {
  // There is no route to probe. Asking for one would get a 404 from the router —
  // which `fleetVerdict` correctly reads as "the app never came up" — so a
  // worker-only app on the probe path could never deploy at all.
  const s = workerOnlySpec();
  const { calls, p } = ports();
  const r = await placeOnFleet("myapp", s, "8.232.255.172", p);

  assert.equal(r.placed, true);
  assert.equal(r.runUrl, "http://8.232.255.172");
  assert.ok(calls.includes("running"), "the node was never asked what it is running");
  assert.ok(!calls.includes("probe"), "a worker-only app was probed over HTTP");
  assert.deepEqual(calls, ["chooseNode", "read", "readRuntime", `place:myapp@fleet-lab-1:${s.image}`, "runtime:myapp=fleet", "running"]);
});

test("an app that serves HTTP is still verified by probing it", async () => {
  // The report exists for apps that cannot be asked. An app that CAN be asked
  // still is, over the load balancer, because that exercises the path real
  // traffic takes — LB, router and app — and the node's report does not.
  const { calls, p } = ports();
  const r = await placeOnFleet("myapp", spec, "8.232.255.172", p);

  assert.equal(r.placed, true);
  assert.ok(calls.includes("probe"));
  assert.ok(!calls.includes("running"), "a web app was verified from the node's report instead of the load balancer");
});

test("a worker the node never confirms is rolled back onto the node it was already on", async () => {
  // The rollback path is the part that must never be wrong, and it must not care
  // which verdict failed. The previous placement goes back on fleet-lab-2 — not
  // this deploy's fleet-lab-1, where `placeApp`'s upsert on (slug, node) would
  // write a SECOND row and leave two copies of the bot placed.
  const s = workerOnlySpec("python bot.py --new");
  const previous = workerOnlySpec("python bot.py --old");
  const { calls, p } = ports({
    runningOnNode: async () => { calls.push("running"); return { ok: false, reason: `the node is not reporting worker "bot" as running` }; },
    readPlacement: async () => { calls.push("read"); return { node: "fleet-lab-2", spec: previous }; },
    readRuntime: async () => { calls.push("readRuntime"); return "cloudrun"; },
  });
  const r = await placeOnFleet("myapp", s, "8.232.255.172", p);

  assert.equal(r.placed, false);
  assert.equal(r.runUrl, undefined);
  assert.match(r.reason!, /not reporting/i);
  assert.deepEqual(calls, [
    "chooseNode",
    "read",
    "readRuntime",
    `place:myapp@fleet-lab-1:${s.image}`,
    "runtime:myapp=fleet",
    "running",
    "nodeFault",
    `place:myapp@fleet-lab-2:${previous.image}`,
    "runtime:myapp=cloudrun",
  ]);
});

test("the running reader being unwired cannot take the rollback with it", async () => {
  // The defect the `nodeFaultFor` guard already documents, reintroduced one line
  // earlier if the new call sits outside the try/catch. A port that is missing
  // entirely throws a TypeError SYNCHRONOUSLY at the call — there is no promise
  // yet — so the exception escapes `placeOnFleet`, and what it leaves behind is
  // the broken spec placed with `apps.runtime` already flipped to 'fleet'.
  const s = workerOnlySpec();
  const { calls, p } = ports();
  delete (p as Partial<PlacementPorts>).runningOnNode;
  const r = await placeOnFleet("myapp", s, "8.232.255.172", p as PlacementPorts);

  assert.equal(r.placed, false);
  assert.ok(calls.includes("unplace:myapp"), "the placement was not rolled back");
  assert.ok(calls.includes("runtime:myapp=fleet"), "the runtime flag was not restored");
});

test("a reader that throws inside placeOnFleet still restores everything", async () => {
  // The asynchronous half of the same rule, and the pre-existing gap it also
  // closes: `probe` throwing had no guard here either.
  const s = workerOnlySpec();
  const { calls, p } = ports({
    runningOnNode: async () => { calls.push("running"); throw new Error("connection terminated unexpectedly"); },
  });
  const r = await placeOnFleet("myapp", s, "8.232.255.172", p);

  assert.equal(r.placed, false);
  assert.ok(calls.includes("unplace:myapp"));
  assert.ok(calls.includes("runtime:myapp=fleet"));
});

test("a probe that throws is a failed verdict too, not an escaped exception", async () => {
  // Pre-existing and untested: `fleetProbe` swallows its own errors, but nothing
  // stopped a DIFFERENT probe implementation from throwing straight through the
  // restore. The guard covers both branches because there is only one.
  const { calls, p } = ports({
    probe: async () => { calls.push("probe"); throw new Error("fetch failed"); },
  });
  const r = await placeOnFleet("myapp", spec, "8.232.255.172", p);

  assert.equal(r.placed, false);
  assert.ok(calls.includes("unplace:myapp"), "a throwing probe skipped the rollback");
});

test("a redeploy is not passed by the version it is replacing", () => {
  // Watched happen on p6mx8, 5 Aug 05:51. fleetProbe returns on the first good
  // answer, and for an app already on this fleet the OUTGOING process is still
  // serving through the load balancer when that request arrives — the node
  // reconciles on its own ten-second clock. So the 200 said "something is
  // serving this slug", which is what it said before the deploy too, run_url
  // was flipped, the deploy was reported live, and the new version then failed
  // its release and never started. Nothing served at all, and it looked exactly
  // like a good deploy until a person opened the app.
  //
  // The node's report is the second question because it compares the IMAGE and
  // the COMMAND against what was just placed.
  return (async () => {
    const { calls, p } = ports({
      probe: async () => { calls.push("probe"); return { code: 200 }; },
      readPlacement: async () => {
        calls.push("read");
        return { node: "fleet-lab-2", spec: { ...spec, image: "registry/myapp:good" } };
      },
      runningOnNode: async () => { calls.push("running"); return { ok: false, reason: "the node is still running the previous image" }; },
    });
    const r = await placeOnFleet("myapp", { ...spec, image: "registry/myapp:new" }, "8.232.255.172", p);

    assert.equal(r.placed, false, "a 200 from the outgoing version must not flip the deploy");
    assert.match(r.reason ?? "", /previous image|not reporting|running/i);
    // …and the restore still lands on the node the app was already on.
    assert.ok(calls.includes("place:myapp@fleet-lab-2:registry/myapp:good"), `restore missing: ${calls.join(", ")}`);
  })();
});

test("a FIRST placement is not made to wait for a report it does not need", () => {
  // The condition is `previous`, and this is why. With no previous placement
  // there is no other process that could have answered the probe, so a 200 is
  // already evidence about the new version. Asking the node as well would add a
  // reconcile interval to every first placement for nothing — and would fail
  // any app whose node has not yet reported, which is the false rollback this
  // change must not introduce.
  return (async () => {
    const { calls, p } = ports({
      probe: async () => { calls.push("probe"); return { code: 200 }; },
      readPlacement: async () => { calls.push("read"); return null; },
    });
    const r = await placeOnFleet("myapp", spec, "8.232.255.172", p);

    assert.equal(r.placed, true);
    assert.ok(!calls.includes("running"), `a first placement asked the node anyway: ${calls.join(", ")}`);
  })();
});

test("a redeploy the node confirms still passes", () => {
  // The other direction: the ordinary redeploy, where the node has swapped and
  // reports the new image. Nothing about this may become slower or stricter.
  return (async () => {
    const { calls, p } = ports({
      probe: async () => { calls.push("probe"); return { code: 200 }; },
      readPlacement: async () => {
        calls.push("read");
        return { node: "fleet-lab-1", spec: { ...spec, image: "registry/myapp:old" } };
      },
      runningOnNode: async () => { calls.push("running"); return { ok: true }; },
    });
    const r = await placeOnFleet("myapp", { ...spec, image: "registry/myapp:new" }, "8.232.255.172", p);

    assert.equal(r.placed, true);
    assert.equal(r.runUrl, "http://8.232.255.172");
  })();
});

/* -------------------------------------------------------------------------- */
/* What the app itself said, on a placement that did not answer.               */
/* -------------------------------------------------------------------------- */

/**
 * The evidence half of a failed placement.
 *
 * On 5 Aug 2026 a container whose first log line was `nginx: [emerg] chown(...)
 * failed (1: Operation not permitted)` was reported as "the fleet router
 * answered, not the app (unhealthy)" and nothing else. The line was already in
 * Cloud Logging — the node ships it and `appLogFilter` reads it — and the repair
 * agent then spent 2.2M tokens and 16 steps guessing at image metadata. So these
 * pin both that the lines are printed AND that they can never change what the
 * failure path does.
 */

test("a failed placement prints what the app said", async () => {
  const said = [
    "nginx: [emerg] chown(\"/var/cache/nginx/client_temp\", 101) failed (1: Operation not permitted)",
    "/docker-entrypoint.sh: Configuration complete; ready for start up",
  ];
  const lines: string[] = [];
  const { p } = ports({
    probe: async () => ({ code: 503 }),
    recentAppLogs: async () => said,
    log: (l) => lines.push(l),
  });
  const r = await placeOnFleet("gzz9j", spec, "lb", p);

  assert.equal(r.placed, false);
  const printed = lines.join("\n");
  for (const s of said) assert.ok(printed.includes(s), `missing from the deploy log: ${s}`);
});

test("a successful placement says nothing about logs", async () => {
  // Evidence is for a failure. Printing a healthy app's log lines on every
  // deploy would bury the one line that matters on the day it appears.
  let asked = false;
  const { p } = ports({ recentAppLogs: async () => { asked = true; return ["noise"]; } });
  const r = await placeOnFleet("gzz9j", spec, "lb", p);

  assert.equal(r.placed, true);
  assert.equal(asked, false);
});

test("a log read that throws does not skip the rollback", async () => {
  // The one property that matters more than the evidence itself. This port is a
  // network call in production; an exception escaping it would leave the app
  // placed and `apps.runtime` flipped to 'fleet' with nothing serving.
  const { calls, p } = ports({
    probe: async () => ({ code: 503 }),
    recentAppLogs: async () => { throw new Error("logging API unreachable"); },
  });
  const r = await placeOnFleet("gzz9j", spec, "lb", p);

  assert.equal(r.placed, false);
  assert.ok(calls.includes("unplace:gzz9j"), "the placement was not rolled back");
  assert.ok(calls.includes("runtime:gzz9j=fleet"), "the runtime flag was not restored");
});

test("an unwired log port is not a crash", async () => {
  // `recentAppLogs` is optional, and a caller that predates it must keep working
  // — the same lesson `nodeFaultFor` learned when a test fixture without the new
  // port took the restore down with it.
  const { calls, p } = ports({ probe: async () => ({ code: 503 }) });
  delete (p as { recentAppLogs?: unknown }).recentAppLogs;
  const r = await placeOnFleet("gzz9j", spec, "lb", p);

  assert.equal(r.placed, false);
  assert.ok(calls.includes("unplace:gzz9j"));
});

/* -------------------------------------------------------------------------- */
/* Running is not working.                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The false positive that shipped a broken deploy as live.
 *
 * i341m v3, 5 Aug 2026: a one-line server that exited before binding. The node
 * restarted it five times, /status said `healthy: false, status: stopped`, and
 * the app's own log said `v3 boot: cannot reach the thing I need, giving up`
 * four times. `runVerdict` compared image and command, found both matching —
 * because a crash-looping process IS in the live set with the new image — and
 * the deploy reported `✓ live` and flipped run_url onto it.
 */

test("a process the node reports as not answering fails the verdict", () => {
  const s = spec;
  const rows = reportFor(s).map((r) => ({ ...r, healthy: false }));
  const v = runVerdict(s, rows);

  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /not answering/);
});

test("a process the node reports as answering passes", () => {
  const s = spec;
  const v = runVerdict(s, reportFor(s).map((r) => ({ ...r, healthy: true })));
  assert.equal(v.ok, true);
});

test("no health reported is not a failure", () => {
  // Three states, not two. A worker has no port and is never probed, and an
  // agent older than the field says nothing at all — refusing on absence would
  // fail every worker-only app and every deploy against a node not yet rebuilt.
  const s = spec;
  const v = runVerdict(s, reportFor(s));
  assert.equal(v.ok, true, v.reason);
});

/* -------------------------------------------------------------------------- */
/* A sibling placed beside its primary runs its own image.                     */
/* -------------------------------------------------------------------------- */

test("a sibling is verified against ITS image, not the app's", () => {
  // A frontend and an API on one node are two programs behind one address, and
  // they are built separately. Comparing the API's row to the app's image would
  // fail every multi-service deploy on this runtime — the node running exactly
  // what was asked for, and the verdict calling it a stale deploy.
  const s: AppSpec = {
    ...spec,
    processes: [
      { name: "web", kind: "web", command: ["/bin/sh", "-c", "node server.js"] },
      { name: "api", kind: "web", command: ["/bin/sh", "-c", "node api.js"], image: "registry/api@sha256:bbb", prefix: "/api" },
    ],
  };
  const rows: ProcessState[] = [
    { slug: s.slug, process: "web", image: s.image, command: ["/bin/sh", "-c", "node server.js"], healthy: true },
    { slug: s.slug, process: "api", image: "registry/api@sha256:bbb", command: ["/bin/sh", "-c", "node api.js"], healthy: true },
  ];
  const v = runVerdict(s, rows);
  assert.equal(v.ok, true, v.reason);
});

test("a sibling running the wrong image still fails", () => {
  // The check must stay a check. A sibling left on its previous build is exactly
  // the redeploy this verdict exists to catch.
  const s: AppSpec = {
    ...spec,
    processes: [
      { name: "web", kind: "web", command: ["/bin/sh", "-c", "node server.js"] },
      { name: "api", kind: "web", command: ["/bin/sh", "-c", "node api.js"], image: "registry/api@sha256:new", prefix: "/api" },
    ],
  };
  const rows: ProcessState[] = [
    { slug: s.slug, process: "web", image: s.image, command: ["/bin/sh", "-c", "node server.js"], healthy: true },
    { slug: s.slug, process: "api", image: "registry/api@sha256:old", command: ["/bin/sh", "-c", "node api.js"], healthy: true },
  ];
  const v = runVerdict(s, rows);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /different image for "api"/);
});

test("adding a sibling does not delete the app's own program", () => {
  // An app that declares no processes IS one implicit web process, and the
  // agent synthesises it from an EMPTY list. Appending a sibling makes the list
  // non-empty, and that synthesis stops — measured on a live deploy: the
  // sibling started, the primary never did, and the probe reported a routing
  // miss three layers away from the cause.
  //
  // `requiredProcesses` is the same reading the verdict does, so it is the right
  // place to pin it: a spec whose only process is the sibling is a spec that has
  // lost the app.
  const withSibling: AppSpec = {
    ...spec,
    processes: [
      { name: "web", kind: "web", command: ["/bin/sh", "-c", "node server.js"] },
      { name: "api", kind: "web", command: ["/bin/sh", "-c", "node api.js"], image: "registry/api@sha256:bbb", prefix: "/api" },
    ],
  };
  const names = requiredProcesses(withSibling).map((p) => p.name).sort();
  assert.deepEqual(names, ["api", "web"]);
});

test("a forwarded hop is not the router answering", () => {
  // `forwarded` means the node that received the request does not hold the app
  // and passed it to the node that does. Whatever came back is the app's.
  //
  // Reading it as a router answer failed a placement that had worked: the app
  // was live on the second node, the probe went load balancer → node one →
  // forwarded → node two → app, and the verdict rejected it on the mark left by
  // the hop.
  assert.equal(fleetVerdict({ code: 200, router: "forwarded" }).ok, true);
  assert.equal(fleetVerdict({ code: 401, router: "forwarded" }).ok, true);
});

test("every other marker is still the router speaking for an app that did not", () => {
  for (const m of ["miss", "unhealthy", "unsigned", "forward-loop"]) {
    const v = fleetVerdict({ code: 404, router: m });
    assert.equal(v.ok, false, `${m} should fail`);
    assert.match(v.reason ?? "", new RegExp(m));
  }
  // And a forward that ended in one of them is still that one.
  const v = fleetVerdict({ code: 403, router: "forwarded, unsigned" });
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /unsigned/);
});

/* -------------------------------------------------------------------------- */
/* The release, recorded where the placement it describes is made.             */
/* -------------------------------------------------------------------------- */

// A deploy is a write: a row saying what shipped, and a column saying which row
// should be running. Recorded HERE rather than in the pipeline because the
// failure path — putting `desired` back — has to sit next to the placement
// restore it mirrors, or the two can disagree about which release an app is
// meant to be running and the reconciler loops between them.
test("a successful placement records a release and asks for it", async () => {
  const said: string[] = [];
  const p = await placeOnFleet("lilna", spec, "10.0.0.1", ports({
    readDesired: async () => 4,
    recordRelease: async () => { said.push("record"); return 5; },
    setDesired: async (_s, r) => { said.push(`desired=${r}`); },
  }).p);
  assert.equal(p.placed, true);
  assert.deepEqual(said, ["record", "desired=5"]);
});

// The same write, reversed. placeOnFleet already restores the previous
// placement on a failed verify; without this, `desired` would stay on the
// release that just failed and the reconciler would roll straight back into it.
test("a failed placement puts the desired release back where it was", async () => {
  const said: string[] = [];
  const p = await placeOnFleet("lilna", spec, "10.0.0.1", ports({
    probe: async () => ({ code: 503 }),
    readDesired: async () => 4,
    recordRelease: async () => 5,
    setDesired: async (_s, r) => { said.push(`desired=${r}`); },
  }).p);
  assert.equal(p.placed, false);
  assert.deepEqual(said, ["desired=5", "desired=4"], "it must go back to 4, not be left on the release that failed");
});

// A first deploy has no previous release, and null is the honest value: this app
// has never had one. Inventing a zero would point desired at a release that does
// not exist.
test("a first deploy that fails leaves no desired release rather than inventing one", async () => {
  const said: (number | null)[] = [];
  await placeOnFleet("lilna", spec, "10.0.0.1", ports({
    probe: async () => ({ code: 503 }),
    readDesired: async () => null,
    recordRelease: async () => 1,
    setDesired: async (_s, r) => { said.push(r); },
  }).p);
  assert.deepEqual(said, [1, null]);
});

// The placement must carry the release it is running, or `desired` and the
// placement diverge permanently: the deploy records release N, asks for it, and
// then places a row still claiming N-1. The reconciler then sees an app whose
// only instance runs the wrong release and rolls a second one forward on every
// pass — for a deploy that had already placed the right thing.
//
// Caught by a real deploy of q6doa: desired moved to 29 and the placement stayed
// on 25.
test("the placement records which release it is running", async () => {
  const placed: unknown[] = [];
  await placeOnFleet("lilna", spec, "10.0.0.1", ports({
    recordRelease: async () => 42,
    placeApp: async (...args: unknown[]) => { placed.push(args); },
  }).p);
  assert.equal(placed.length, 1);
  assert.equal((placed[0] as unknown[])[3], 42, "placeApp must be told the release it is placing");
});

// The restore is the exception, and it must stay one. Putting the previous spec
// back should keep pointing at the release that spec belongs to — naming the
// release that just failed would make the rollback claim to be the thing it
// rolled back from.
test("a restore names no release, so the placement keeps the one its spec belongs to", async () => {
  const placed: unknown[][] = [];
  await placeOnFleet("lilna", spec, "10.0.0.1", ports({
    probe: async () => ({ code: 503 }),
    recordRelease: async () => 42,
    readPlacement: async () => ({ node: "fleet-lab-2", spec }),
    placeApp: async (...args: unknown[]) => { placed.push(args); },
  }).p);
  assert.equal(placed.length, 2, "one place, then one restore");
  assert.equal(placed[0][3], 42);
  assert.equal(placed[1][3], undefined, "the restore must not claim the failed release");
});
