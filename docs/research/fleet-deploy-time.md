# Where fleet-deploy time goes (below the Cloud Run cold-start half)

Scope: the `fleet` stage (p50 87.7s) and, where it touches it, the `build`
stage (p50 33.3s) of a deploy that lands on a Compute Engine VM node instead
of Cloud Run. The `job-cold-start` / control-plane-image-pull problem
(`docs/superpowers/plans/2026-08-06-deploy-cold-start.md`) is out of scope
and not discussed further.

All line numbers are current as of the working tree at the time of writing.

## 0. Stage boundaries

`stages.around("fleet", () => placeOnFleet(...))` —
`apps/web/lib/deploy-pipeline.ts:3699`. `placeOnFleet` is imported from
`apps/web/lib/fleet-place.ts:482`. The stage timer wraps **only**
`placeOnFleet` — node selection, placement, and verification. Building the
image is a separate, earlier stage: `stages.around("build", ...)` at
`apps/web/lib/deploy-pipeline.ts:3351`, invoked from `buildImage()`
(`deploy-pipeline.ts:3334`) which `runFleetDeploy` calls at
`deploy-pipeline.ts:3534`, **before** the `fleet` stage opens. So the 87.7s
`fleet` p50 is placement + verification time only, with no build work mixed
in — the two stages are already cleanly separated in the instrumentation.

## 1. Decomposing the `fleet` stage — `placeOnFleet` (`fleet-place.ts:482-659`)

In order:

1. **`chooseNode()`** — `fleet-place.ts:488`, implemented at
   `apps/web/lib/fleet.ts:147-168`. One SQL query (`fleet_nodes` LEFT JOIN
   `fleet_placements`, filtered to `last_seen > now() - interval '90
   seconds'`, memory-overcommit check in JS). No polling, no retry — this is
   a single round trip and is not a meaningful contributor.
2. Two more single-row reads: `readPlacement` (`fleet.ts:103`) and
   `readRuntime` (`fleet.ts:171-174`) — again single queries, negligible.
3. **`placeApp()`** (write) then **`setRuntime()`** (write) —
   `fleet-place.ts:513,517` → `fleet.ts:79`, `fleet.ts:183`. Plain UPDATE/
   UPSERT statements. Negligible.
4. **Verification — the actual wait.** Two different mechanisms depending on
   whether the app has a web process (`specHasWeb`, `fleet-place.ts:328`):
   - **App with a web process:** `fleetProbe()` (`fleet-place.ts:274-316`)
     polls the load balancer with the app's own health path. **24 attempts,
     5000 ms apart, first attempt immediate** (`fleet-place.ts:280-281,
     294-295`) — a 0–120s budget, comment explicitly calls this "two
     minutes."
   - **App with no web process (worker-only):** `awaitRunning()`
     (`fleet-place.ts:442-464`) polls the node's own self-report instead.
     Same budget (24×5000ms, `fleet-place.ts:449-450`) but **sleeps before
     the first check** (`fleet-place.ts:454-455`) — deliberately, per the
     comment at `fleet-place.ts:420-429`, because the node's report cannot
     possibly be about a placement written moments ago.
   - **The expensive case — a redeploy of an app with a web process.**
     `fleetProbe` alone is not trusted: a probe answered by the *previous*
     process on the same slug (still serving while the node hasn't
     reconciled the swap yet) would read as success. So when `previous`
     placement exists, the code runs `awaitRunning` **again, after** the
     probe passes (`fleet-place.ts:570`: `probed.ok && previous ?
     await runningOnNode(...) : probed`). This is a second, sequential poll
     loop layered on top of the first, and it is the normal case — most
     fleet deploys are redeploys, not first placements. See §4 for why this
     specific wait is large.
5. On failure: restore previous placement / unplace, restore runtime flag,
   log app's own last lines via `recentAppLogs` — all DB/log operations,
   not time sinks (`fleet-place.ts:624-651`).

**Nothing here is a fixed sleep with no purpose** — every wait is either a
poll interval (5s) or a deliberate one-interval delay before trusting a
report. But two independent 5s-granularity poll loops are chained on the
common path (redeploy + web process), and neither is a fixed floor, both are
"until true, checked every 5s."

## 2. How a node learns about new desired state

**Pure pull, no push**, and this is a documented, deliberate choice:
`services/fleet/agent/desired.go:3-13` — "The agent ASKS. Nothing pushes to
a node... a control plane that is down cannot take running apps with it."

- `main.go:562`: `interval = flag.Duration("interval", 10*time.Second, ...)`.
- `main.go:670-676`: the reconcile loop is `for { reconcileOnce(); time.Sleep(*interval) }` — an unconditional fixed-interval poll, not a long-poll or backoff.
- Each pass's `loadDesired()` (`main.go:689`) calls `a.src.Fetch()` →
  `fromControlPlane()` (`desired.go:234-283`), a single POST/response — the
  same HTTP call also uploads the node's fault/running report (see §4).

**Theoretical minimum** from "control plane commits the new placement" to
"the node's HTTP request asking for it lands": 0s, if the write happens the
instant before a poll fires. **Expected value**: for a fixed 10s interval
and a write landing at a uniformly random point in the cycle, **~5s**.
**Worst case**: just under 10s. There is no jitter or stagger visible in the
code, so 21 nodes each on their own boot-time-derived phase would spread
load in practice, but nothing in `main.go` deliberately does this.

## 3. What the node does before an app answers — `Runtime.Start` (`container.go:647-763`)

Called from `reconcileOnce` via `startMany` (`main.go:1184-1286`).
**Across different processes/apps this is already concurrent**: `startMany`
fans out over a semaphore sized `min(NumCPU, 8)` (`main.go:1188-1192`), and
the comment at `main.go:860-867` records that the serial version "does not
survive contact with a real node" — 25 apps took minutes serially. So
cross-app parallelism is already solved.

**Within one process's `Start()` call, the steps are strictly serial**, in
this order (`container.go:647-731`):

1. `EnsureImage()` (`container.go:104-125`) — pull if not already present
   and unpacked in containerd's local store; this is a genuinely fresh
   digest every deploy (Cloud Build just pushed it), so **this is a real
   pull, not a cache hit, on essentially every deploy**. No prefetch/warm
   step exists anywhere in the reconcile path or in the web-side pipeline —
   grepped for "prepull"/"warm image" and found nothing. **This is the
   single largest unquantified cost in the whole path**: the code has no
   instrumentation that reports pull duration anywhere queryable (see the
   gap noted in §5).
2. `r.Stop(id)` — clear any leftover sandbox under this id (cheap, local).
3. `prepareRootfs()` (`container.go:192+`) — containerd snapshot + lease +
   mount. Local disk operation.
4. `imageConfig()` — parse image config for entrypoint/cmd/env. Local, from
   the already-pulled image.
5. `dbPathReachable()` guard, **only if `hasDatabase(app)`**
   (`container.go:689-693`, `secrets.go:182`) — a TCP dial with a 3s
   timeout; fails fast on success (a connect, not a full timeout), adds
   real time only when the DB proxy is actually down.
6. `resolveAll()` secrets (`secrets.go:104-140`) — **already concurrent**:
   one goroutine per secret, fanned out over a channel
   (`secrets.go:116-122`), explicitly commented as being concurrent "because
   an app with a database has several and doing them in series adds a round
   trip each." Each individual call has a 15s timeout (`secrets.go:73`) but
   normally resolves in one Secret Manager round trip.
7. `SetupSandboxNet()` (`network.go:126`) — local netns/veth setup.
8. `writeSpec()` / `writeManifest()` — local disk writes.
9. `runscDetached()` — starts the gVisor sandbox (`run --detach`).
10. Confirm-running poll: `runscStatus` checked every 200ms up to a **30s
    deadline** (`container.go:742-758`) — this is a ceiling, not a
    typical wait; it returns as soon as `runsc` reports "running," which
    for a container that starts cleanly is on the order of the container's
    own boot time, not seconds of polling overhead.

**What could be concurrent but isn't**: step 1 (image pull) and step 6
(secret resolution) depend on nothing in each other — pulling the image and
resolving secrets could run in parallel instead of pull-then-resolve. Step 5
(DB reachability) likewise doesn't depend on the image and could run
alongside the pull. None of these overlaps exist today; they're all
sequenced one after another inside `Start()`.

**Health only after start, on the same pass.** A newly started process's
`live` entry gets `confirmed: time.Now()` immediately
(`main.go:1269-1270`), but its route is written with `Healthy: l.ok`
(`main.go:1354`) where `l.ok` starts `false`. The good news:
`reconcileOnce` calls `a.probeAll()` and `a.writeRoutes()` at its own tail
(`main.go:1178-1179`), **after** `startMany` in the same pass
(`main.go:1173-1175`) — so a freshly started, already-answering app gets
`Healthy: true` published in the *same* reconcile pass it started in, not
one poll cycle later. (There's also an independent 5s health-check ticker,
`main.go:660-668`, which is redundant with this but doesn't add delay.)

## 4. The verification tail — what the control plane still waits for

Two distinct tails, and the second one is the expensive, easy-to-miss one.

**(a) LB probe tail.** `fleetProbe` polls the LB via
`http://${loadBalancer}${path}` every 5s (`fleet-place.ts:274-316`), reading
`x-supersonic-router` to distinguish "the router answered, not the app"
(`fleetVerdict`, `fleet-place.ts:233-250`) from a real app answer. The
router itself marks a route unhealthy until `probeAll` has confirmed it
(`router.go:359-365`), and reloads the routes file by polling its mtime
every 500ms (`router.go:378-397`) — negligible next to the 5s probe
interval and the 10s node-poll interval that dominate.

**(b) The redeploy corroboration tail — the biggest single serial wait
identified.** On a redeploy (`previous` placement exists — the normal
case), passing the LB probe is not enough
(`fleet-place.ts:544-570`, comment explains why: the *previous* version can
still answer through the LB for a while after the new one is placed). The
code then calls `runningOnNode()` (`fleet.ts:444-465`), which reads the
`fleet_process_running` table — a row the **node** upserts on its own sync.
Tracing when that row can possibly reflect the *new* process:

- `reconcileOnce` calls `loadDesired()` **first thing**
  (`main.go:734`), which builds and sends the sync payload — including
  `ReportRunning()` (`main.go:388-424`) — **before** this same pass does any
  of its own placing/starting work (`main.go:860` onward is after
  `loadDesired` returns). So the report sent on pass *N* reflects state as
  of the *end of pass N-1*.
- Therefore a process started during pass N is not reported to the control
  plane until pass **N+1**'s sync call — i.e., roughly one full 10s
  `interval` (`main.go:562`) after the node started it, not within the same
  pass.
- On the control-plane side, `awaitRunning` (`fleet-place.ts:442-464`)
  **sleeps 5s before its first check** (deliberate, see §1), then polls
  the DB every 5s.

Chained: node starts app on pass N → LB probe succeeds sometime in [0,120s]
of polling → corroboration wait begins → must wait for pass N+1's sync
(≈10s after pass N, not from when corroboration starts) before the DB row
even exists → then up to a 5s DB-poll granularity to notice it. **Net
added latency after the app is already visibly serving correctly: on the
order of 10-15s, essentially every time**, because it is gated on the
node's *next* poll cycle rather than on the state the node already knows
the instant `Start()` returns. This is the clearest "seconds hiding in a
slow poll at the end" in the whole path — the corroboration step is
correct in what it checks (image+command match, per `runVerdict`,
`fleet-place.ts:375-417`) but unnecessarily slow in how it learns the
answer, because the node's report is one full interval stale by
construction (§2's pull model, applied to the report direction too).

## 5. The floor — without changing the architecture

Everything below assumes: no push architecture, no long-polling, no
change to place→verify→flip. Only tightening intervals and removing
avoidable seriality.

| Component | Current (typical) | Floor if fixed |
|---|---|---|
| Control plane → node "there's new work" | ~5s avg (10s poll, `main.go:562`) | ~1-2s avg if `interval` were shortened, e.g. to 2-3s (costs more sync traffic per node × node-count — not evaluated here) |
| Image pull + sandbox boot (`Start()`, `container.go:647`) | **unmeasured** — no timing surfaced past the node's own log line (`main.go:1257`, local only) | unchanged without a real prefetch/warm mechanism (out of scope: "without changing the architecture") or a smaller/cached image; can't lower the floor from code reading alone |
| Secret resolution | already concurrent (`secrets.go:108`) | already at floor |
| Health becomes true | same reconcile pass as start (`main.go:1173-1179`) | already at floor |
| LB probe noticing health | up to 5s poll granularity (`fleet-place.ts:281`) | ~0.5-1s if probe interval were shortened, mirroring the router's own 500ms file-watch cadence |
| Redeploy corroboration tail | ~10-15s (§4: gated on node's *next* sync, not current knowledge) | **near 0** if the node's sync report were built from live state at *send* time instead of from state captured at the top of the *previous* pass — i.e., call `ReportRunning()`/`Report()` immediately before the POST rather than relying on `loadDesired()`'s ordering, or simply report inline right after `startMany` finishes rather than waiting a full cycle. This is the one change in this list that is pure sequencing, not physics. |

**Rough floor**: stripping the corroboration tail (~10-15s) and tightening
the two poll intervals (save another ~5-8s combined) removes on the order
of **20-25s** from the current 87.7s p50 `fleet` stage **without touching
image pull time**, landing the stage around **60-65s** — still dominated by
whatever `EnsureImage` + sandbox boot actually costs, which this reading of
the code cannot quantify (no per-substep timing is logged to anywhere the
control plane or `deploy_stages` can see). If that pull+boot cost is itself
small (a few seconds, for a lean custom image) the realistic floor could be
closer to **25-35s** total for the `fleet` stage; if it's large (a heavy
image, cold registry) the floor is whatever that pull costs plus roughly
10-15s of irreducible poll/probe overhead layered on top. **This range is a
guess** — the actual pull+boot duration needs to be measured (e.g., timing
`container.go:1257`'s log line across real deploys, or adding a stage split
inside `placeOnFleet` for "waiting for node" vs "verifying").

## What could not be determined from the code alone

- **Image pull duration in practice.** `EnsureImage` (`container.go:104`)
  has no timing instrumentation; the only elapsed-time number
  (`main.go:1257`, `%.1fs`) covers the *whole* `Start()` call end-to-end,
  is logged only to the node's local log, and is not attributable to pull
  vs. boot vs. anything else, nor visible from the control-plane side or in
  `deploy_stages`. This is the largest gap and the thing most worth
  measuring before acting on the floor estimate above.
- **Typical image size on the fleet path**, and hence realistic pull time
  against Artifact Registry from a GCE node — not present anywhere in the
  code read for this task.
- **How many of the 87.7s p50 attempts actually need multiple 5s polling
  rounds** vs. pass on the first check — the code sets the *ceiling*
  (120s budget) and the *minimum* (one 5s sleep for `awaitRunning`,
  immediate for `fleetProbe`), but the actual distribution of how many
  rounds a p50 deploy takes is a runtime fact, not a code fact.
- Whether reconcile intervals are staggered across the 21+ nodes to avoid
  synchronized load on the control plane — nothing in `main.go` sets a
  random phase, but this could be handled at the systemd/provisioning layer
  outside the files read here.

## Key files

- `apps/web/lib/deploy-pipeline.ts:3699` (fleet stage boundary), `:3334-3399` (build stage / `buildImage`), `:3532-3719` (`runFleetDeploy`)
- `apps/web/lib/fleet-place.ts` (whole file — `placeOnFleet`, `fleetProbe`, `awaitRunning`, `runVerdict`, `fleetVerdict`)
- `apps/web/lib/fleet.ts:79-186` (`placeApp`, `placementFor`, `chooseNode`, `runtimeOf`, `setRuntime`), `:444-465` (`runningOnNode`)
- `services/fleet/agent/desired.go` (pull-only design, `Source.Fetch`)
- `services/fleet/agent/main.go:557-677` (main loop, intervals), `:733-1180` (`reconcileOnce`), `:1184-1286` (`startMany`), `:1293-1331` (`probeAll`), `:1338-1392` (`writeRoutes`), `:330-424` (`reportFaults`/`reportRunning`/`confirmRunning`)
- `services/fleet/agent/container.go:104-125` (`EnsureImage`), `:647-763` (`Start`)
- `services/fleet/agent/secrets.go:104-140` (`resolveAll`, already concurrent)
- `services/fleet/agent/router.go:340-398` (health gate, file-watch cadence)
