import type { Lane } from "./lanes";
import type { AppSpec, AgentProcess } from "./fleet-spec";
import type { Runtime, ProcessState } from "./fleet";

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
 * A failure at 1 leaves the app placed nowhere new, so whatever was already on a
 * node keeps serving. That is the deploy failing safely, not the deploy
 * succeeding: every `placed: false` below is a failed deploy now, and the caller
 * treats it as one.
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
  // `chooseNode`, `placeApp` and `unplaceApp` USED TO BE HERE, and their absence
  // is the change. A deploy no longer picks a node or writes a placement: it
  // records a release, asks for it, and converges — so the only way an app can
  // be placed is the planner, and a second placement policy cannot drift into
  // existence beside it.

  /**
   * What is placed for this app right now, and where — before this deploy
   * overwrites it. The node travels with the spec because a restore must land
   * on the node the app was already running on, not on whichever node this
   * deploy's own `chooseNode` happened to pick.
   */
  readPlacement: (slug: string) => Promise<{ node: string; spec: AppSpec } | null>;
  /** Which runtime the app is on right now, before this deploy changes it. */
  readRuntime: (slug: string) => Promise<Runtime>;
  /**
   * The release this app is currently asked to run, read BEFORE this deploy
   * changes it — so a failed one can put it back. Null when it has never had one.
   */
  readDesired: (slug: string) => Promise<number | null>;
  /** Record what this deploy shipped, immutably, and return its id. */
  recordRelease: (slug: string, spec: AppSpec) => Promise<number>;
  /** Ask for a release. The whole of what a deploy does to change what runs. */
  setDesired: (slug: string, release: number | null) => Promise<void>;
  /**
   * Converge this app NOW, through the reconciler's own planner.
   *
   * The spec's step 3 is "the placement function creates placements for V — the
   * same function the reconciler calls", and this is that call. The deploy no
   * longer picks a node or writes a placement: it records the release, asks for
   * it, and lets the planner put it BESIDE what is running. That is what makes
   * the rollout rolling, and it is the same policy that absorbs a node failure —
   * `planPlacements` refuses to bin-pack precisely so there is room to place a
   * new instance without evicting the old one first.
   *
   * Returns how many steps it took, so "nowhere to put it" is still an answer
   * this function can report rather than a timeout it has to wait out.
   */
  converge: (slug: string) => Promise<number>;
  /**
   * Sleep. A port so a test can make the readiness wait instant — without it
   * every rollout test would pay the real budget, and a suite nobody runs is
   * worse than one that is slightly less faithful.
   */
  wait: (ms: number) => Promise<void>;
  /**
   * The node holding a READY placement of this release, or null.
   *
   * Ready is the NODE's word, not a probe's: `promoteReady` sets it when the
   * node's own sync confirms a process whose image matches the release. That is
   * what makes "which version answered" unambiguous during a roll, when two
   * releases are placed at once and the load balancer may reach either.
   */
  readyAt: (slug: string, release: number) => Promise<string | null>;
  /**
   * Drop this release's placements, leaving any other release's alone.
   *
   * The failure path needs exactly this and not `unplaceApp`. Reverting `desired`
   * alone would leave the broken version placed while the old one comes up
   * beside it — the planner only drains a stale placement once the wanted one is
   * ready — so the version that just failed its verify would keep taking traffic
   * for as long as the recovery takes. The spec says the failed release's
   * placements are removed, and this is that removal.
   */
  removeRelease: (slug: string, release: number) => Promise<void>;
  setRuntime: (slug: string, runtime: Runtime) => Promise<void>;
  /** One request at the fleet, addressed the way the edge proxy will address it. */
  probe: (slug: string) => Promise<{ code: number; router?: string }>;
  /**
   * The other verdict: is the NODE running what was just placed on it?
   *
   * For an app with no web process there is no request to make — a bot publishes
   * no route — so the proof has to come from the node's own report rather than
   * from the load balancer. A port like everything else the rollback path
   * touches, so the order below stays checkable without a database.
   */
  runningOnNode: (slug: string, node: string, spec: AppSpec) => Promise<Eligibility>;
  /**
   * Does the node holding this app blame ITSELF for its failure?
   *
   * A port rather than a direct import, like everything else the rollback path
   * touches, so the order below stays checkable without a database.
   */
  nodeFaultFor: (slug: string) => Promise<{ node: string; detail: string } | null>;
  /**
   * The app's OWN last words, from the node, when a placement did not answer.
   *
   * A port because this is the only thing in the failure path that is neither
   * a verdict nor a rollback: it is evidence, and it must not be able to change
   * what happens — a log read that throws or hangs cannot be allowed to skip the
   * restore below.
   */
  recentAppLogs?: (slug: string) => Promise<string[]>;
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
  hasDockerfile: boolean;
  /** How many `worker` processes this app declares. */
  workers: number;
}): Eligibility {
  // A worker-only app is placeable now, and the refusal that used to stand here
  // said why it was not: "the only proof accepted is an HTTP answer through the
  // load balancer, and a worker publishes no route to ask". That was never a
  // fleet limitation — the fleet runs a bot better than Cloud Run does, which is
  // half of why it exists — it was a limitation of the CHECK, and the node now
  // reports what it is confirmed to be running. What remains are the two cases
  // where that report still cannot answer.
  // A CRON-ONLY APP IS ELIGIBLE, and the refusal that stood here is gone.
  //
  // It was never about capability. The node runs crons — `rtmsw--nightly` and
  // `izuvx--nightly` have fired every ten minutes on fleet-lab-2 since 11 Aug.
  // It was about the CHECK: `runVerdict` demanded a running process, a cron is
  // never running (the agent's `units` excludes it, because the scheduler owns
  // it), so every deploy of a correctly-configured app rolled back. `runVerdict`
  // now answers that case explicitly, so this no longer has to refuse it.
  //
  // Removed rather than relaxed, because the Cloud Run container lane it used to
  // route to no longer exists. A refusal whose destination is gone is not a
  // routing decision; it is a failed deploy wearing one.

  if (a.serviceless && !a.hasDockerfile) {
    // A serviceless app with no Dockerfile is built by `builds submit --pack`,
    // and that image must not be handed to a node.
    //
    // Stated directly rather than left to the lane. What actually selects that
    // builder is `useDockerBuild = hasDockerfileNow` in the pipeline, not the
    // lane label — `laneFor` happens to make the two agree today, which makes
    // the guarantee contingent on a file in another module. The reasons are the
    // buildpack rule's below: that submit writes no cloudbuild.yaml, so it has
    // no logging destination and runs as the default build account, and it names
    // the image before anything built it.
    return {
      ok: false,
      reason: "this app has no Dockerfile, so its image is built by `builds submit --pack`, which the fleet must not borrow",
    };
  }
  if (a.staticServe || a.lane === "static") {
    // Published to GCS and served by the shared static server. There is no image
    // to pull. VM-FLEET moves this onto a node as an ordinary resident process
    // at step 4; until then it stays where it is.
    return { ok: false, reason: "a static app has no image of its own to run" };
  }
  // WAS: the runner lane — one shared prebuilt runtime whose customer code
  // arrived as an encrypted bundle at start, so a node handed that image would
  // start the runner and never the app. It is deleted, and this refusal with it.
  if (a.lane === "buildpack" && !a.hasDockerfile) {
    // A buildpack image is made BY the deploy: `gcloud run deploy --source`
    // runs the builder and Cloud Run names what comes out, so at decision time
    // there is no reference to hand a node. The fleet has no `--source` of its
    // own to run.
    //
    // Only when there is no Dockerfile, and that qualifier is the whole point.
    // The lane is fixed before the pipeline writes its generated, SPA and
    // Next.js fallback Dockerfiles, so an app can reach here labelled
    // "buildpack" having built a perfectly ordinary image with a resolvable
    // digest. `useDockerBuild` in the pipeline asks this same question at build
    // time; this asks it at decision time, which is when it is needed.
    //
    // The pipeline has a second builder — `builds submit --pack`, guarded by
    // `serviceless` — and it is deliberately not borrowed for this. It writes
    // no cloudbuild.yaml, so it has no logging destination, and Cloud Build
    // REFUSES a user-specified build account without one: it is the only build
    // in the pipeline that still runs as the default account, and using it here
    // would move every buildpack app off the scoped build identity as a side
    // effect of a fleet canary. It would also mean naming the image before
    // anything built it, which is the exact mistake — a tag is not evidence —
    // that the fleet branch exists to stop making.
    //
    // Until then this lane is named rather than accidentally excluded. It was
    // already excluded, by `!a.image` below, because the pipeline has no name
    // for a buildpack image at decision time — but that is a refusal that
    // disappears the moment somebody gives the lane a deterministic tag, and
    // what it would leave behind is a node running an image nobody built.
    return { ok: false, reason: "a buildpack image is made by the deploy itself, so there is none to hand a node" };
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
  hasDockerfile: boolean;
  workers: number;
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
  // `forwarded` is not the router answering. It means the node this request
  // reached does not hold the app and passed it to the node that does, and
  // whatever came back is the APP's — which is the whole point of forwarding.
  //
  // Treating it as a router answer failed a placement that had worked: the app
  // was live on the second node, the probe went load balancer → node one →
  // forwarded → node two → app, and the verdict read the mark left by the hop
  // as evidence that no app had answered. Every other marker — miss, unhealthy,
  // unsigned, forward-loop — IS the router speaking for an app that did not.
  const marker = (r.router ?? "").split(",").map((m) => m.trim()).filter((m) => m && m !== "forwarded");
  if (marker.length) return { ok: false, reason: `the fleet router answered, not the app (${marker.join(", ")})` };
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
 *
 * "The way the edge proxy will" now includes signing. The node's router refuses
 * an unsigned request with 403 and `X-Supersonic-Router: unsigned` once its gate
 * is on, and `fleetVerdict` reads any router marker as "the router answered, not
 * the app" — so an unsigned probe would roll back every placement and make the
 * fleet undeployable the moment enforcement lands. With no secret in the
 * environment nothing is sent and this behaves exactly as it did, which is the
 * same bootstrap property both other sides have.
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

  // Trimmed for the same reason the proxy and the node trim theirs: this value
  // reaches the deploy job from Secret Manager, `openssl rand` ends its output
  // with a newline, and a header value containing one throws rather than 403s.
  const edgeSecret = (process.env.FLEET_EDGE_SECRET ?? "").trim();
  const headers: Record<string, string> = { "x-supersonic-slug": slug };
  if (edgeSecret) headers["x-supersonic-edge"] = edgeSecret;

  let last: { code: number; router?: string } = { code: 0 };
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, delayMs));
    try {
      const res = await f(`http://${loadBalancer}${path}`, {
        headers,
        // A 302 to /login is a working app, and following it would probe
        // whatever the redirect points at instead.
        redirect: "manual",
      });
      last = { code: res.status, router: res.headers.get("x-supersonic-router") ?? undefined };
    } catch {
      // A refused connection is not an answer. Recorded as such rather than
      // thrown, and the reason is no longer "the deploy already succeeded
      // elsewhere" — under the fork there is no elsewhere. It is that a thrown
      // exception here escapes `placeOnFleet` entirely, skipping the restore of
      // the previous placement and the runtime flag below. `code: 0` is a
      // verdict, and a verdict is what that restore is driven by.
      last = { code: 0 };
    }
    if (fleetVerdict(last).ok) return last;
  }
  return last;
}

/**
 * Does this spec have a web process — and therefore something to probe?
 *
 * The TypeScript mirror of `hasWeb(processesOf(app))` in the agent, including
 * the branch that matters: an app carrying NO `processes` is not worker-only, it
 * is an ordinary app whose start command is its web process under an older
 * spelling, and `processesOf` synthesises exactly one web process for it. Reading
 * an absent list as "no web" would send every app that predates the process model
 * down the report path, where it has no rows and no deploy would ever pass.
 */
export function specHasWeb(spec: AppSpec): boolean {
  if (!spec.processes?.length) return true;
  return spec.processes.some((p) => p.kind === "web");
}

/**
 * The processes a node must be running for this placement to count.
 *
 * `web` and `worker` only, mirroring the agent's `units`: a `release` is run once
 * and is then gone, and a `cron` is owned by the scheduler and never enters
 * `a.live` at all — so requiring either would require a row the node can never
 * send.
 */
export function requiredProcesses(spec: AppSpec): AgentProcess[] {
  if (!spec.processes?.length) {
    // The implicit web process, built the way `processesOf` builds it.
    return [{ name: "web", kind: "web", command: spec.command }];
  }
  return spec.processes.filter((p) => p.kind === "web" || p.kind === "worker");
}

function sameArgv(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Is the node running what was just placed on it?
 *
 * Every required process must have a reported row whose IMAGE AND COMMAND match
 * the placed spec. Both, because that pair is the agent's own predicate for "this
 * is a different program" — `reconcileOnce` leaves a live process alone only
 * while both still match, and restarts it when either changes. Comparing the
 * image alone would pass a redeploy that changed a worker's command against the
 * process still running the old one, and pass it INSTANTLY, because the previous
 * deploy's rows are still there and `reported_at` is refreshed on every sync.
 *
 * The converse is the reason this is the right predicate rather than a strict
 * one: a change the node would NOT act on legitimately passes on the process
 * already running, because that process IS the program the spec describes. What
 * it cannot see is an env or secret change — see the note on `awaitRunning`.
 *
 * Fails closed in every direction. No rows, a missing process, a stale row that
 * the reader's freshness window dropped: all of them are "not ok", and not ok is
 * what drives the restore.
 */
export function runVerdict(spec: AppSpec, rows: ProcessState[]): Eligibility {
  const required = requiredProcesses(spec);

  // Scheduled work is confirmed by the PLACEMENT, not by a running process.
  // Stated as its own case rather than falling through the empty-list guard
  // below: that guard exists because "everything I required is running" is
  // vacuously true of nothing, and an app whose only work is a cron must not
  // pass by accident just because it happens to require nothing.
  if (!required.length && spec.processes?.some((p) => p.kind === "cron")) {
    return { ok: true, reason: "this app declares only scheduled work, so the placement is the confirmation" };
  }

  if (!required.length) {
    // Not reachable from `buildAppSpec` — `fleetEligibility` refuses an app with
    // no long-running process before it is ever placed — but a verdict with
    // nothing to check must never be a pass. "Everything I required is running"
    // is vacuously true of nothing, and that is the shape a check quietly
    // becomes when the thing it checks is refactored out from under it.
    return { ok: false, reason: "this placement declares no long-running process, so there is nothing the node could confirm" };
  }
  const byName = new Map(rows.map((r) => [r.process, r]));
  for (const p of required) {
    const got = byName.get(p.name);
    if (!got) return { ok: false, reason: `the node is not reporting ${p.kind} "${p.name}" as running` };
    // Against the PROCESS's image when it has one. A sibling placed beside its
    // primary runs its own image, and comparing it to the app's would fail every
    // multi-service deploy on this runtime — the node would be running exactly
    // what was asked for and the verdict would call it a stale deploy.
    const wantImage = p.image ?? spec.image;
    if (got.image !== wantImage) {
      return { ok: false, reason: `the node is running a different image for "${p.name}" — this deploy has not reached it` };
    }
    if (!sameArgv(got.command, p.command)) {
      return { ok: false, reason: `the node is running a different command for "${p.name}" — this deploy has not reached it` };
    }
    // Present is not working, and believing it was is how a broken deploy went
    // out as live. A container that starts and exits is in the agent's live set
    // for the whole time reconcile is restarting it, so it reports the NEW image
    // on every sync while serving nothing — image and command both matched, and
    // this function said yes. Measured on 5 Aug 2026: i341m v3 exited before
    // binding, the node logged `not running, restarting (3/5)`, and the deploy
    // announced `✓ live`.
    //
    // Only an explicit `false`. Absent means nobody asked — a worker has no port
    // to probe, and an agent older than this field says nothing — and refusing
    // on absence would fail every worker-only app and every deploy made against
    // a node that has not been rebuilt yet.
    if (got.healthy === false) {
      return { ok: false, reason: `the node started "${p.name}" and it is not answering — the app came up and then stopped` };
    }
  }
  return { ok: true };
}

/**
 * Wait for the node to report the placed spec as running.
 *
 * The counterpart to `fleetProbe` for an app with no route, with the same budget
 * — 24 attempts, 5 seconds apart, two minutes — and one deliberate difference:
 * it SLEEPS FIRST. `fleetProbe` asks at t≈0 because an HTTP answer at t=0 is
 * still an answer from the app. A report at t=0 is not: the node polls every ten
 * seconds, so nothing it has said yet can be about a placement written moments
 * ago, and the rows sitting there are the previous deploy's — still fresh,
 * because every sync refreshes `reported_at`. One interval of delay is what makes
 * the first answer capable of being about this deploy at all.
 *
 * Two minutes is the same budget the web probe has today, and on this path it
 * has to cover a `release` process as well: a release blocks the app's own
 * processes from starting at all and `RunToCompletion` allows it thirty minutes.
 * A worker-only app with a slow migration will therefore roll back. Said here
 * rather than left to be discovered on the node.
 *
 * Errors are swallowed into a verdict, exactly as `fleetProbe` swallows a refused
 * connection, and for the same reason: an exception thrown out of here escapes
 * `placeOnFleet` and skips the restore of the previous placement and runtime,
 * which is the one thing in that function that must never be skipped.
 */
export async function awaitRunning(
  slug: string,
  node: string,
  spec: AppSpec,
  read: (slug: string, node: string) => Promise<ProcessState[]>,
  opts: { attempts?: number; delayMs?: number; sleepImpl?: (ms: number) => Promise<void> } = {},
): Promise<Eligibility> {
  const attempts = opts.attempts ?? 24;
  const delayMs = opts.delayMs ?? 5000;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let last: Eligibility = { ok: false, reason: "the node has not reported this app as running" };
  for (let i = 0; i < attempts; i++) {
    await sleep(delayMs);
    try {
      last = runVerdict(spec, await read(slug, node));
    } catch {
      last = { ok: false, reason: "could not read what the node is running" };
    }
    if (last.ok) return last;
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
   * Returned rather than written, so `run_url` keeps exactly one writer.
   * `markAppLive` is that writer, and it runs moments after this: writing here
   * as well would be a value overwritten by whatever the caller passes it — the
   * kind of flip that silently undoes itself and leaves an app placed on a node
   * nothing routes to.
   */
  runUrl?: string;
}

/**
 * How long a deploy waits for the node to report the new release running.
 *
 * The same budget the probe already used — 24 attempts, five seconds apart —
 * because it is the same question with the same answer: a cold start that pulls
 * an image is slow, and a slow start mistaken for a failure trades a false pass
 * for a false rollback, which is the worse of the two.
 */
const READY_ATTEMPTS = 24;
const READY_INTERVAL_MS = 5_000;

/**
 * Put things back after a deploy that did not prove itself.
 *
 * ONE function for both failure paths — the version that never came up and the
 * version that came up and failed its verify — because they must not be able to
 * drift. The old code had the restore written once and reached from one place;
 * the rolling sequence has two ways to fail, and two copies of a restore is how
 * one of them quietly stops restoring.
 *
 * THE FAILED RELEASE'S PLACEMENTS GO FIRST, and that ordering is the point.
 * Reverting `desired` alone would leave the broken version placed while the old
 * one comes up beside it — the planner drains a stale placement only once the
 * wanted one is ready — so the version that just failed would keep taking
 * traffic for the whole length of the recovery.
 */
async function revert(
  slug: string,
  release: number,
  previousRuntime: Runtime,
  previousDesired: number | null,
  reason: string,
  p: PlacementPorts,
): Promise<Placement> {
  await p.removeRelease(slug, release);
  await p.setDesired(slug, previousDesired);
  // Converged while the runtime flag still says 'fleet': the planner selects on
  // it, so restoring the flag first would leave the previous release asked for
  // and never placed.
  await p.converge(slug);
  await p.setRuntime(slug, previousRuntime);
  p.log(previousDesired === null ? `· nothing placed — ${reason}` : `· kept the previous version — ${reason}`);
  return { placed: false, reason };
}

export async function placeOnFleet(
  slug: string,
  spec: AppSpec,
  loadBalancer: string,
  p: PlacementPorts,
): Promise<Placement> {
  // Read BEFORE anything is asked for: the writes below overwrite the runtime
  // flag and the desired release, so after them both the version that was
  // working and the runtime it was on are only knowable from here.
  const previous = await p.readPlacement(slug);
  const previousRuntime = await p.readRuntime(slug);
  const previousDesired = await p.readDesired(slug);

  // Recorded before it is asked for. A release is the record of what shipped,
  // and recording it after a successful placement would mean a placement that
  // succeeded and a timeline that lost it — the same shape as a build whose
  // outcome was never written.
  const release = await p.recordRelease(slug, spec);

  // 1. ASK, and let the planner place. This function used to choose a node and
  //    write the placement itself, which is why a deploy was stop-then-start: it
  //    overwrote the row the old version was running from. Now it records the
  //    release, asks for it, and calls the same convergence the reconciler runs
  //    — which places the new release BESIDE the old one and drains the old only
  //    once the new is ready. The headroom that makes this possible is the same
  //    policy that lets a node absorb another node's apps: `planPlacements`
  //    refuses to bin-pack.
  //
  //    Runtime first, because `desiredFor` only hands a node placements for apps
  //    whose runtime is 'fleet' — the planner would place a row no node would
  //    ever be told about.
  await p.setRuntime(slug, "fleet");
  await p.setDesired(slug, release);
  const steps = await p.converge(slug);

  // 2. WAIT for the node to say it is running this release.
  //
  //    Ready is the node's word rather than a probe's, and during a roll that
  //    distinction is the whole point: two releases are placed at once and the
  //    load balancer may reach either, so "something answered" cannot tell them
  //    apart. `promoteReady` sets this state only when the node's own sync
  //    confirms a process whose image matches the release.
  // NOWHERE TO PUT IT IS ANSWERED IMMEDIATELY, not waited out. The planner takes
  // a step for every deploy — the release is new every time, so there is always
  // something it has never placed — and zero steps therefore means it found no
  // healthy node with room. Waiting the full readiness budget to then blame the
  // app would send someone to debug a repository that is fine.
  if (steps === 0) {
    const reason = "no node has room (or none reported recently)";
    p.log(`✕ nowhere to place it — ${reason}. The version already running keeps serving; this deploy has not shipped.`);
    return await revert(slug, release, previousRuntime, previousDesired, reason, p);
  }

  let node: string | null = null;
  for (let i = 0; i < READY_ATTEMPTS && node === null; i++) {
    node = await p.readyAt(slug, release);
    if (node === null) await p.wait(READY_INTERVAL_MS);
  }

  if (node === null) {
    return await revert(slug, release, previousRuntime, previousDesired,
      "the node never reported this version running", p);
  }

  // 2. verify — by the only means the app actually offers.
  //
  //    An app with a web process is asked, through the load balancer, addressed
  //    the way the proxy will address it. Not over localhost: the point is to
  //    exercise the path real traffic takes, LB included.
  //
  //    An app WITHOUT one publishes no route, so there is nothing to ask. Its
  //    proof is the node's own report of what it is confirmed to be running,
  //    which is the channel phase 1C-1 opened and this half completes. Both
  //    answers are the same kind of thing — a verdict — so everything below is
  //    single and untouched.
  //
  //    Guarded, and this is the same lesson as `nodeFaultFor` below, learned one
  //    line earlier. A port that is missing entirely throws a TypeError
  //    SYNCHRONOUSLY at the call, before there is a promise to attach anything
  //    to — so an escape here would skip the restore with the broken spec placed
  //    and `apps.runtime` already flipped to 'fleet'. A verdict we could not
  //    obtain is not a pass; it is the same failure as any other unverifiable
  //    deploy, and it takes the same restore.
  let verdict: Eligibility;
  try {
    if (!specHasWeb(spec)) {
      verdict = await p.runningOnNode(slug, node, spec);
    } else {
      const probed = fleetVerdict(await p.probe(slug));
      // A REDEPLOY's probe can be answered by the version it is replacing.
      //
      // fleetProbe returns on the first good answer, and for an app already on
      // this fleet the outgoing process is still serving through the load
      // balancer when the first request arrives — the node reconciles on its
      // own ten-second clock and has not necessarily swapped yet. So a 200 says
      // "something is serving this slug", which is exactly what it said before
      // the deploy, and the flip goes through on the strength of the version
      // being replaced.
      //
      // Watched happen on p6mx8, 5 Aug 05:51: the probe passed, run_url was
      // flipped, the deploy was reported live — and the new version then failed
      // its release and never started, so nothing served at all. The most
      // expensive kind of false positive, because it is indistinguishable from
      // a good deploy until a person opens the app.
      //
      // Only when a PREVIOUS placement exists, and that is the whole condition:
      // on a first placement there is no other process that could have answered,
      // so the probe alone is already evidence about the new version.
      //
      // The node's report is the right second question because it compares the
      // IMAGE and the COMMAND against what was just placed — the agent's own
      // predicate for "this is a different program". And it waits on the same
      // budget the probe does (24 × 5s), so a slow start is not mistaken for a
      // failure; without that this would trade a false pass for a false
      // rollback, which is the worse of the two.
      verdict = probed.ok && previous ? await p.runningOnNode(slug, node, spec) : probed;
    }
  } catch {
    verdict = { ok: false, reason: "could not read what the node is running" };
  }
  if (!verdict.ok) {
    // Whose failure was this? The probe cannot tell — it sees silence at the
    // load balancer, and silence is what an app crash and a dead node proxy
    // look like from out here. The node knows, and by now has had the whole
    // length of the probe's retries to say so on a sync that runs every ten
    // seconds.
    //
    // Corroboration matters in both directions. A false "node" costs one
    // rolled-back deploy; a false "app" costs a repair run with write access to
    // a customer's repository. But a node that blamed itself for everything
    // would hide real app bugs behind a platform verdict, so this fires only on
    // the node's own typed verdict and never on a guess from the probe's
    // silence.
    //
    // Guarded, and that is not defensive habit: this is a database call, and an
    // exception escaping here would skip the restore below — the one thing in
    // this function that must never be skipped, and the reason `fleetProbe`
    // swallows its own errors too. A fault we could not read is simply not
    // corroboration.
    // try/catch rather than `.catch()`, and that is not style. A port that is
    // missing entirely throws a TypeError SYNCHRONOUSLY, before there is a
    // promise to attach a handler to — so `.catch()` would let exactly the
    // unwired-port case through, which is how this was found: a test fixture
    // that had not been given the new port took the restore down with it.
    let nf: { node: string; detail: string } | null = null;
    try {
      nf = await p.nodeFaultFor(slug);
    } catch {
      nf = null;
    }
    // `?? ` rather than a cast: `Eligibility.reason` is optional, and a verdict
    // that failed without saying why still has to carry SOMETHING to the repair
    // agent — an empty reason reads as "no problem found".
    const reason = nf
      ? `FLEET_NODE_FAULT: ${nf.node} reports this app cannot start on it${nf.detail ? ` — ${nf.detail}` : ""}`
      : verdict.reason ?? "the app did not prove itself, and gave no reason";

    // What the app itself said before it stopped answering.
    //
    // Every line of this was already in Cloud Logging while the deploy failed —
    // the node's ops agent ships /srv/apps/<slug>/*.log and `appLogFilter`
    // already reads it — and nothing asked. Measured on 5 Aug 2026: a container
    // whose FIRST log line was `nginx: [emerg] chown(...) failed (1: Operation
    // not permitted)` was reported to the user as "the fleet router answered,
    // not the app (unhealthy)", and the repair agent then spent 2.2M tokens and
    // 16 steps guessing at EXPOSE and image metadata. The answer was sitting in
    // a log the platform can read.
    //
    // Printed BEFORE the restore, so the order a person reads is: what the app
    // said, then what we did about it. Errors are swallowed whole and the port
    // is optional: this is evidence, and evidence that cannot be gathered must
    // never stop the rollback that follows it.
    // ATTACHED TO THE REASON, not only printed. Printing puts the evidence in
    // front of the person watching; the repair agent reads the returned reason,
    // and for a fleet app that reason was "the app answered 503 from the fleet"
    // with the cause sitting in a log nobody handed it. That is the same defect
    // one runtime up — the symptom reaching the agent while the cause stays
    // behind — which `fetchContainerError` was written for on Cloud Run and which
    // came back the moment the fleet became the only runtime.
    let evidence = "";
    try {
      const lines = p.recentAppLogs ? await p.recentAppLogs(slug) : [];
      if (lines.length) {
        p.log(`· what ${slug} said on the node before it stopped answering:`);
        for (const line of lines) p.log(`    ${line}`);
        evidence = `\n\nWhat ${slug} said on the node before it stopped answering:\n${lines.map((l) => `  ${l}`).join("\n")}`;
      }
    } catch { /* no evidence is not a verdict */ }

    // The restore is `revert`, shared with the path where the node never
    // reported the release running at all. The previous version comes back
    // through the PLANNER — desired goes back, the failed release's placements
    // are removed, and the convergence re-places what was asked for — rather
    // than through an in-memory copy of a spec read at the top of this function.
    // That removes the whole class of "what if the process died between reading
    // and writing", which the spec names as the reason to do it this way.
    //
    // The log lines ride on the RETURNED reason only. They were just printed in
    // full a few lines up, and repeating them inside the one-line "kept the
    // previous version — …" would say the same thing twice to the same reader.
    const done = await revert(slug, release, previousRuntime, previousDesired, reason, p);
    return { ...done, reason: `${done.reason ?? reason}${evidence}` };
  }

  // 3. DRAIN THE VERSION THIS ONE REPLACES, now that the new one is proven.
  //
  //    The planner holds a stale placement until the wanted release is ready —
  //    that is what makes the rollout rolling — so this convergence is the one
  //    that ends the overlap. Without it the old version keeps taking traffic
  //    until the next scheduled pass, up to a minute of a deploy reporting the
  //    new version live while the old one still answers for it.
  //
  //    After the verify and not before: draining on the strength of a placement
  //    that had not proven itself is stop-then-start with extra steps.
  await p.converge(slug);

  // 4. the address for the flip, which the caller performs. The edge proxy needs
  //    no change: it already forwards x-supersonic-slug, and the fleet router
  //    reads the same header.
  p.log(`Running on ${node}`);
  return { placed: true, node, runUrl: `http://${loadBalancer}` };
}
