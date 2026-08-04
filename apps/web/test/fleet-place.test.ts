import { test } from "node:test";
import assert from "node:assert/strict";
import { fleetEligibility, fleetVerdict, fleetProbe, fleetPlacementWanted, placeOnFleet, chooseRuntime, type PlacementPorts } from "../lib/fleet-place";
import type { AppSpec } from "../lib/fleet-spec";
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
    nodeFaultFor: async () => { calls.push("nodeFault"); return null; },
    log: () => {},
  };
  return { calls, p: { ...base, ...over } };
}

// `lane` is widened to `Lane` (not narrowed to the literal "container") so the
// override cases below — which swap in "runner" — typecheck against
// `Partial<typeof eligible>`.
const eligible = { lane: "container" as Lane, image: "img", staticServe: false, serviceless: false, hasDockerfile: false };

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
    [{ serviceless: true }, /route|worker-only/i],
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

test("a worker-only app is not placed yet, and the reason is the check, not the runtime", () => {
  // The fleet runs a bot better than Cloud Run does — that is half of why it
  // exists. What is missing is the VERIFY step: the only proof this pipeline
  // accepts is an HTTP answer through the load balancer, and a worker publishes
  // no route to ask. Placing one would mean flipping on faith.
  const r = fleetEligibility({ ...eligible, serviceless: true });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /no route|worker-only/i);
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
  });
  assert.equal(got.ok, false);
  if (!got.ok) assert.match(got.reason!, /buildpack|source/i);
});

test("a Dockerfile does not rescue the lanes refused for other reasons", () => {
  // Each of these is refused for something a Dockerfile does not change: a
  // static app has no image of its own, the runner's image is shared and the
  // app's code is not in it, and a serviceless app publishes no route to probe.
  for (const c of [
    { lane: "static" as const, staticServe: true, serviceless: false },
    { lane: "runner" as const, staticServe: false, serviceless: false },
    { lane: "container" as const, staticServe: false, serviceless: true },
  ]) {
    const got = fleetEligibility({
      lane: c.lane,
      image: "us-central1-docker.pkg.dev/p/r/x@sha256:abc",
      staticServe: c.staticServe,
      serviceless: c.serviceless,
      hasDockerfile: true,
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
