import { test } from "node:test";
import assert from "node:assert/strict";
import { fleetEligibility, fleetVerdict, fleetProbe, fleetPlacementWanted, placeOnFleet, type PlacementPorts } from "../lib/fleet-place";
import type { AppSpec } from "../lib/fleet-spec";

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
    placeApp: async (slug, node) => { calls.push(`place:${slug}@${node}`); },
    setRuntime: async (slug, rt) => { calls.push(`runtime:${slug}=${rt}`); },
    probe: async () => { calls.push("probe"); return { code: 200 }; },
    log: () => {},
  };
  return { calls, p: { ...base, ...over } };
}

const eligible = { lane: "container" as const, image: "img", staticServe: false, serviceless: false };

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

test("an app that does not answer from the fleet is put back, before anything routes to it", async () => {
  const { calls, p } = ports({ probe: async () => ({ code: 502 }) });
  const r = await placeOnFleet("myapp", spec, "8.232.255.172", p);

  assert.equal(r.placed, false);
  // Back to cloudrun, which drops the placement. And no address is handed back,
  // so the caller writes the Cloud Run url it already had — no traffic was ever
  // aimed at a node that could not serve it.
  assert.ok(calls.includes("runtime:myapp=cloudrun"));
  assert.equal(r.runUrl, undefined);
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
  assert.deepEqual(calls, ["chooseNode", "place:myapp@fleet-lab-1", "runtime:myapp=fleet", "probe"]);
});
