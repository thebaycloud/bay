import type { Lane } from "./lanes";
import type { AppSpec } from "./fleet-spec";
import type { Runtime } from "./fleet";

/**
 * Placing an app on the fleet, at deploy time.
 *
 * This is `migrate.sh` with the hand taken off it. The shell script proved the
 * sequence on 19 live apps and its order is the whole safety property:
 *
 *   1. place    the node starts the app; nobody is routed to it yet
 *   2. verify   ask the fleet for it directly, over the load balancer
 *   3. flip     only now does apps.run_url point at the fleet
 *
 * A failure at 1 leaves the app placed nowhere new, so nothing changes for it.
 * A failure at 2 is harder: placing the new spec at step 1 already overwrote
 * whatever the node was running before, and already flipped `apps.runtime` to
 * `fleet` — `desiredFor` will not hand a node anything otherwise — so both the
 * spec that used to answer and the runtime it was on are only recoverable from
 * what was read before those writes. There is no Cloud Run to fall back to any
 * more, so that previous spec and runtime — or, on a first deploy, no
 * placement and whatever the runtime was before — are what a failed verify
 * restores.
 *
 * Everything the fleet needs from the outside world arrives as a port, so the
 * order above — and the rollback, which is the part that must never be wrong —
 * is checkable without a database, a node, or a load balancer.
 */

export interface PlacementPorts {
  chooseNode: () => Promise<string | null>;
  placeApp: (slug: string, node: string, spec: AppSpec) => Promise<void>;
  unplaceApp: (slug: string) => Promise<void>;
  /**
   * What is placed for this app right now, and where — before this deploy
   * overwrites it. The node travels with the spec because a restore must land
   * on the node the app was already running on, not on whichever node this
   * deploy's own `chooseNode` happened to pick.
   */
  readPlacement: (slug: string) => Promise<{ node: string; spec: AppSpec } | null>;
  /** Which runtime the app is on right now, before this deploy changes it. */
  readRuntime: (slug: string) => Promise<Runtime>;
  setRuntime: (slug: string, runtime: Runtime) => Promise<void>;
  /** One request at the fleet, addressed the way the edge proxy will address it. */
  probe: (slug: string) => Promise<{ code: number; router?: string }>;
  log: (line: string) => void;
}

export interface Eligibility {
  ok: boolean;
  reason?: string;
}

/**
 * Whether this deploy should try the fleet at all.
 *
 * The same shape as `selectedBuilder`'s BUILDKIT_APPS, and for the same reason:
 * main deploys straight to production and there is no staging, so the only way
 * to prove a new path against real traffic is to prove it on ONE app first.
 * `FLEET_APPS=<slug>[,<slug>]` moves those; `FLEET_PLACEMENT=1` moves everything.
 *
 * That matters more here than it did for a builder. The placement spec has just
 * grown env and secrets, and no app has ever been placed carrying either — the
 * 19 that moved went with the hardcoded six fields migrate.sh wrote.
 */
export function fleetPlacementWanted(env: Record<string, string | undefined>, slug: string): boolean {
  const canaries = (env.FLEET_APPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (canaries.includes(slug)) return true;
  return env.FLEET_PLACEMENT === "1";
}

/**
 * Whether this app can run on a node at all.
 *
 * Not a policy question — a capability one. Each `no` here is a thing the fleet
 * genuinely cannot do yet, and saying which one keeps "did not move" from
 * reading as "failed".
 */
export function fleetEligibility(a: {
  lane: Lane;
  image: string;
  staticServe: boolean;
  serviceless: boolean;
}): Eligibility {
  if (a.serviceless) {
    // Not a fleet limitation — the fleet runs a bot better than Cloud Run does,
    // which is half of why it exists. It is a limitation of the CHECK: the only
    // proof accepted below is an HTTP answer through the load balancer, and a
    // worker-only app publishes no route to ask. Placing one would be flipping
    // on faith, and the whole point of this sequence is not doing that.
    return { ok: false, reason: "a worker-only app has no route to verify from the fleet yet" };
  }
  if (a.staticServe || a.lane === "static") {
    // Published to GCS and served by the shared static server. There is no image
    // to pull. VM-FLEET moves this onto a node as an ordinary resident process
    // at step 4; until then it stays where it is.
    return { ok: false, reason: "a static app has no image of its own to run" };
  }
  if (a.lane === "runner") {
    // The runner lane's image is one shared prebuilt runtime and the customer's
    // code arrives as an encrypted bundle at start. A node handed that image
    // would start the runner and never the app. Not worth teaching the fleet:
    // this lane is what §8b deletes.
    return { ok: false, reason: "the runner lane's image is shared, and its code is not in it" };
  }
  if (!a.image) return { ok: false, reason: "this deploy produced no image to place" };
  return { ok: true };
}

/**
 * Where this app is deployed. Decided BEFORE anything is deployed.
 *
 * The same judgement `fleetEligibility` makes, with an answer that names the
 * other branch — because the pipeline no longer deploys to Cloud Run and then
 * also places. A database-backed app under that shape failed its first step, on
 * the runtime it was leaving, for a reason belonging to the runtime it was
 * going to.
 */
export function chooseRuntime(a: {
  lane: Lane;
  image: string;
  staticServe: boolean;
  serviceless: boolean;
}): { runtime: Runtime; reason?: string } {
  const can = fleetEligibility(a);
  return can.ok ? { runtime: "fleet" } : { runtime: "cloudrun", reason: can.reason };
}

/**
 * Whether the fleet is really serving this app.
 *
 * `<500` is not enough on its own. The fleet router returns 404 for a slug it
 * has no route for, which is byte-for-byte what an app whose root path is
 * undefined returns — so the router marks its own responses, and a response
 * carrying that mark means the app never came up. Missing it flips run_url to a
 * fleet that serves nothing, which is an outage rather than a failed migration.
 */
export function fleetVerdict(r: { code: number; router?: string }): Eligibility {
  if (r.router) return { ok: false, reason: `the fleet router answered, not the app (${r.router})` };
  if (!r.code) return { ok: false, reason: "no answer from the fleet" };
  if (r.code >= 500) return { ok: false, reason: `the app answered ${r.code} from the fleet` };
  // A 404 at the root or a redirect to /login is a working app. Only the router
  // saying "I have no route" and a 5xx are failures.
  return { ok: true };
}

/**
 * Ask the fleet for this app, the way the edge proxy will.
 *
 * Over the load balancer rather than a node's own address, and addressed by
 * `x-supersonic-slug` rather than Host: by the time the proxy forwards a
 * request, Host is the upstream's, so routing on Host alone makes every proxied
 * request a miss. The header is how the shared static server has always worked
 * and the fleet router reads the same one.
 *
 * Retried, because a sandbox does not serve the instant it is placed. A
 * single-shot probe rolls back healthy apps for being slow, which is the most
 * expensive false negative available here — it is indistinguishable, from the
 * outside, from the fleet simply not working.
 */
export async function fleetProbe(
  loadBalancer: string,
  slug: string,
  opts: { fetchImpl?: typeof fetch; attempts?: number; delayMs?: number; path?: string } = {},
): Promise<{ code: number; router?: string }> {
  const f = opts.fetchImpl ?? fetch;
  const attempts = opts.attempts ?? 24;
  const delayMs = opts.delayMs ?? 5000;
  // The app's own health path, so a database-backed app is checked on a request
  // that needs the database. Its root would answer 200 with no database at all.
  const path = opts.path?.startsWith("/") ? opts.path : `/${opts.path ?? ""}`;

  let last: { code: number; router?: string } = { code: 0 };
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, delayMs));
    try {
      const res = await f(`http://${loadBalancer}${path}`, {
        headers: { "x-supersonic-slug": slug },
        // A 302 to /login is a working app, and following it would probe
        // whatever the redirect points at instead.
        redirect: "manual",
      });
      last = { code: res.status, router: res.headers.get("x-supersonic-router") ?? undefined };
    } catch {
      // A refused connection is not an answer. Recorded as such rather than
      // thrown: the caller's decision is the same either way, and throwing here
      // would fail a deploy that has already succeeded on Cloud Run.
      last = { code: 0 };
    }
    if (fleetVerdict(last).ok) return last;
  }
  return last;
}

export interface Placement {
  placed: boolean;
  node?: string;
  reason?: string;
  /**
   * The address to publish, present only once the app has answered from it.
   *
   * Returned rather than written, so `run_url` keeps exactly one writer. Writing
   * it here would be overwritten moments later by `markAppLive`, which carries
   * the Cloud Run url this deploy started with — a flip that silently undoes
   * itself and leaves the app placed on a node nothing routes to.
   */
  runUrl?: string;
}

export async function placeOnFleet(
  slug: string,
  spec: AppSpec,
  loadBalancer: string,
  p: PlacementPorts,
): Promise<Placement> {
  const node = await p.chooseNode();
  if (!node) {
    // The edge case §8b names as unhandled. There is one node today, so "full"
    // means one reboot — and an app deployed during it must not end up placed
    // nowhere, or placed on a node named null. Staying on Cloud Run is the
    // correct answer and costs nothing: the app is already live there.
    const reason = "no node has room (or none reported in the last 90s)";
    p.log(`· staying on Cloud Run — ${reason}`);
    return { placed: false, reason };
  }

  // Read BEFORE placing: placing overwrites the row, and setRuntime("fleet")
  // below overwrites the runtime flag, so after those writes both the version
  // that was working and the runtime it was on are only knowable from here.
  const previous = await p.readPlacement(slug);
  const previousRuntime = await p.readRuntime(slug);

  // 1. place. Nothing routes here yet; run_url still points at wherever it did.
  await p.placeApp(slug, node, spec);
  // desiredFor only hands a node placements for apps whose runtime is 'fleet',
  // so this has to happen before the probe even though it is not yet proven —
  // there is nothing for step 2 to verify otherwise.
  await p.setRuntime(slug, "fleet");

  // 2. verify, through the load balancer, addressed the way the proxy will
  //    address it. Not over localhost: the point is to exercise the path real
  //    traffic takes, LB included.
  const verdict = fleetVerdict(await p.probe(slug));
  if (!verdict.ok) {
    // There is no Cloud Run to fall back to any more, so the fallback is the
    // last version that answered, on the node it was already running on — not
    // this deploy's node, which `placeApp`'s upsert would otherwise treat as a
    // second placement rather than overwriting the first. With none — a first
    // deploy — the placement is dropped rather than left pointing at something
    // that does not serve.
    if (previous) {
      await p.placeApp(slug, previous.node, previous.spec);
      p.log(`· kept the previous version — ${verdict.reason}`);
    } else {
      await p.unplaceApp(slug);
      p.log(`· nothing placed — ${verdict.reason}`);
    }
    // The runtime flag flipped to 'fleet' above so the probe had something to
    // check. Restoring it — rather than leaving it — matters most on the
    // first-deploy branch: unplacing drops the row but the flag would still
    // say 'fleet', which is what would have silently pointed a node's next
    // reconcile at a placement that no longer exists.
    await p.setRuntime(slug, previousRuntime);
    return { placed: false, reason: verdict.reason };
  }

  // 3. the address for the flip, which the caller performs. The edge proxy needs
  //    no change: it already forwards x-supersonic-slug, and the fleet router
  //    reads the same header.
  p.log(`Running on ${node}`);
  return { placed: true, node, runUrl: `http://${loadBalancer}` };
}
