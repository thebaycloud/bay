import { test } from "node:test";
import assert from "node:assert/strict";
import { fleetEligibility, fleetVerdict, fleetProbe, fleetPlacementWanted, placeOnFleet, chooseRuntime, type PlacementPorts } from "../lib/fleet-place";
import type { AppSpec } from "../lib/fleet-spec";
import type { Lane } from "../lib/lanes";

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
    log: () => {},
  };
  return { calls, p: { ...base, ...over } };
}

// `lane` is widened to `Lane` (not narrowed to the literal "container") so the
// override cases below — which swap in "runner" — typecheck against
// `Partial<typeof eligible>`.
const eligible = { lane: "container" as Lane, image: "img", staticServe: false, serviceless: false };

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

test("a container app with an image is placeable", () => {
  assert.equal(fleetEligibility(eligible).ok, true);
  assert.equal(fleetEligibility({ ...eligible, lane: "buildpack" }).ok, true);
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
