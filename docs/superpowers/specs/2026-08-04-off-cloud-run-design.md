# Off Cloud Run: the fleet becomes the only runtime for customer apps

**Date:** 2026-08-04
**Status:** approved, not implemented
**Replaces the ordering in** `2026-08-04-fleet-as-deploy-target-design.md`, whose
seven pieces were ordered by capability. Its piece 1 is built and merged; this
spec reorders everything after it, on evidence that piece 1 did not have.

## The decision

Every customer app runs on our own VMs. Six services stay on Cloud Run because
they are ours, not customers': `supersonic-control-plane`, `supersonic-proxy`,
`supersonic-shot`, `supersonic-landing`, `supersonic-tunnel`,
`supersonic-static`.

Done when `gcloud run services list --project supersonic-deploy-prod` returns
those six and nothing else, and no code in the repository creates a Cloud Run
resource for a customer app.

The control plane was considered for the move and deliberately kept where it is.
It deploys itself on every push to `main` and it manages the nodes; putting it on
a node it manages means a bad deploy of the control plane removes the thing that
deploys the fix. That is a distinct piece of work with its own bootstrap problem
and it is out of scope here.

## What six parallel readers changed about this plan

The programme was going to be "build the missing runtimes, then migrate". It is
not. Reading the code found that the migration is nearly done and the
*operability* is missing.

| Believed before | Found in the code |
|---|---|
| The buildpack lane is the biggest blocker | It is nearly empty. Production runs `RUNNER=0`, so every non-static app without a Dockerfile gets one generated (`deploy-pipeline.ts:1664,1693`) and `laneFor` returns `container`. Buildpack is reached only when the Dockerfile render throws (`:1818-1826`). |
| Deleting the runner lane loses build-time secrets | False. `buildkitBuildConfig` mounts Secret Manager secrets too (`build-config.ts:284-295,315,319`) and production runs `BUILDER=buildkit`. The comment at `build-config.ts:102-107` saying otherwise is stale and misled a reader. |
| Buildpack apps cannot produce a digest before placement | Some already do. SPA and Next.js fallback Dockerfiles are written at `deploy-pipeline.ts:1922,1925` — **after** the lane is fixed at `:1866`. Those apps carry `lane === "buildpack"` with `useDockerBuild === true`, build real images with resolvable digests, and are refused placement by a string (`fleet-place.ts:109`). |
| A `toFleet` guard on `deployProcesses` closes the double-cron hazard | It does not. `orphans` removes only what the config dropped (`process-plan.ts:157-172`), so an app that moves to the fleet leaves its worker pool, job and Scheduler entry running forever. The Cloud Run process set must be reconciled to empty *first*. |
| Cron behaviour carries over | It does not. See "Crons change meaning silently" below. |

So the fork is not what blocks this. What blocks it is that a node cannot be
operated: nothing ships logs off it, no per-process status reaches the control
plane, a failed release stalls every other app on the machine, and crons that
worked on Cloud Scheduler stop firing with no signal.

## Scope

**In:** closing a live authorization gap; making a node observable and safe to
run other people's code on; verifying the substrate; widening the set of apps the
fleet accepts; flipping the default; deleting the Cloud Run app path.

**Out:** moving the control plane or the proxy off Cloud Run. Serving static
apps from a node — `supersonic-static` keeps that job, because a static site has
no code to sandbox. HTTPS and DNS work: `*.supersonic.cv` already resolves to
`8.233.7.157`, a global HTTPS load balancer terminating a Certificate Manager
wildcard, and none of that changes.

---

## Phase 0 — Stop the bleeding

None of this depends on the migration. All of it is wrong today.

### The fleet load balancer has no authentication

Four facts, each verified rather than argued:

1. `8.232.255.172` answers from the open internet. An unauthenticated `curl`
   from a laptop, off-VPC, returned the fleet router's own page carrying
   `X-Supersonic-Router: no-slug`.
2. `router.go:177-238` reads `x-supersonic-slug` and proxies. There is no
   credential check of any kind.
3. There is no Cloud Armor: `gcloud compute security-policies list` returns
   `Listed 0 items`.
4. `desiredFor` selects on `p.node = $1 AND a.runtime = 'fleet'`
   (`lib/fleet.ts:58-69`) and never reads `apps.visibility`. A private app is
   placed and served like any other.

What follows: a request carrying `x-supersonic-slug: <slug>` reaches a
fleet-placed app directly, bypassing the proxy's entire access layer — the
Auth.js session check, `decideAccess`, `app_grants`, workspace scoping. Slugs are
not secret; a slug *is* the app's public hostname.

The firewall is not the hole. `allow-lb-to-fleet` admits only Google's
`130.211.0.0/22` and `35.191.0.0/16` to port 8080 on the node, which is exactly
right. The load balancer in front of that port is the hole.

**Why nobody looked:** `router.go:16-20` claims the router "refuses to serve
anything the control plane has not marked public, so the gap is a closed door
rather than an open one." No such refusal exists in `ServeHTTP`. The comment
describes an intention and reads as a guarantee.

**The fix.** The proxy sets `x-supersonic-edge: <secret>` from Secret Manager;
the router refuses any request without it, compared in constant time — the same
shape `FLEET_TOKEN` already uses for `/api/fleet/sync` (`desired.go:144`). Ship
the router first in accept-either mode, then the proxy, then make it mandatory.
Roughly 15 lines of Go and 3 of TypeScript.

**Its exposure today is bounded but unknown, and that is not a reason to wait.**
Nineteen apps serve from the fleet (`docs/VM-FLEET.md:451`), chosen precisely
because they had no secrets and no database to carry (`:494-496`). Whether any of
the nineteen is *private* is unverified — visibility and secrets are different
properties and answering it needs a database query nobody can currently run.
Phase 4 makes the question moot by placing everything, private apps included.

### `FLEET_APPS` is armed against a node nobody has checked

`supersonic-deploy-job` carries `FLEET_APPS=t1cyj` and `FLEET_LB=8.232.255.172`.
Deploys run in that job, not in the control-plane service
(`app/api/deploy/route.ts:220`), so the canary is live.

The node it points at has never had its Cloud SQL proxy started and never had its
nftables ruleset parsed. `t1cyj` has no database and its Cloud Run service keeps
serving until `run_url` flips, so a failed placement does not take the app down —
it marks the deploy failed and dispatches the repair agent against a customer's
repository over our own unverified node. Remove `FLEET_APPS` until Phase 2 passes.

### The proxy sends a signed identity assertion over the public internet

`SKIP_ID_TOKEN` is unset, so `forward.ts:35-37` mints an ID token for whatever
the target is — including `http://8.232.255.172`. It is useless as a Cloud Run
invoker token (wrong audience), but it is a Google-signed assertion of the proxy
service account's identity travelling in cleartext. Gate the call on the target
hostname ending in `.run.app`.

### Two comments that are false, and cost something each

`router.go:16-20` (above) and `build-config.ts:102-107` (build secrets). Each one
sent a careful reader to a wrong conclusion during this investigation. Fix them
with the code they describe.

---

## Phase 1 — The node becomes operable

This is the bulk of the programme and none of it is migration.

### One status channel closes three holes at once

Today `/api/fleet/sync` carries a node's report about **itself** — name, zone,
ip, memory, cpus (`lib/fleet.ts:28-34`, `desired.go:31-37`) — once per node every
10 seconds. Nothing about any app ever travels upward. The agent knows a
database-backed app was refused because the node's proxy is dead
(`container.go:409-413`, `secrets.go:167-173`); it logs that and drops it
(`main.go:519-524`).

Three consequences, all from the same absence:

- A dead node proxy classifies as the app's fault, and the repair agent edits a
  customer's repository over our outage.
- Worker-only apps cannot deploy to the fleet at all, because the only accepted
  proof is an HTTP answer through the load balancer and a worker publishes no
  route (`fleet-place.ts:88-95`).
- A crash-looping worker, a failed cron and an unparseable schedule are invisible
  to everyone except someone reading journald over SSH.

**Extend the existing sync body; do not add a push channel.** The pull direction
is the availability story stated in three separate places, and latency is not the
binding constraint — the deploy already waits about two minutes at the probe, so
ten seconds of staleness sits well inside it.

The request gains a per-process array and a node-level `dbPath` record. Two
details carry the weight:

- **`fault` is an enum decided at the source**, not a sentence re-parsed
  downstream: `none | node | app | unknown`. The node is the only place that
  knows `dbPathReachable` failed rather than the app crashing. The repository
  already documents what substring classification costs — the
  `enotfound`/`ModuleNotFoundError` boundary bug at `deploy-errors.ts:72-79`.
- **`reportHash`**: send the full process set only when it changed, otherwise the
  hash alone. This keeps "full set, never a delta" while making steady state
  nearly free, and it has to land with the first version rather than after the
  first scale test finds it.

`FLEET_NODE_FAULT` joins `PLATFORM_MARKERS` (`deploy-errors.ts:130`), so a node
fault classifies as `blame:"platform"`, takes the branch at
`deploy-pipeline.ts:3352-3359`, and never reaches the repair agent.

**Three states, not two.** The unit sets `KillMode=process`
(`provision.sh:357-359`), so restarting the agent does not stop the sandboxes —
the apps keep serving. "The agent has not reported" must therefore read as
`unknown`, never as `down`, or every agent upgrade invents a fleet-wide outage.
Staleness is a property of the **node** (`fleet_nodes.last_seen`, the 90-second
window `chooseNode` already uses), never of a process row.

**The serviceless verdict requires image equality.** A still-running *previous*
worker must not count as proof that the new deploy succeeded — the same class of
mistake as placing a tag instead of a digest. Require `state = running` with the
image this deploy placed, across two consecutive reports so a crash-loop cannot
flash green.

**Authorization gets worse before it gets better, and must be handled here.**
`FLEET_TOKEN` is a shared secret and any holder can post as any node. Today that
buys "read desired state"; with status writes it buys "mark another node's apps
failed and steer deploy verdicts". Accept a status row only for a `(slug, node)`
pair that already exists in `fleet_placements` — a node cannot report on apps it
was never given. The real fix is a GCE instance identity token, and this raises
its priority.

### Nothing ships logs off the node

`getLogs` filters `resource.type=cloud_run_revision` (`gcloud.ts:345`) and
`appLogs` has no fleet branch. For an app on a node, `supersonic logs` returns
nothing. Everything sits in `/srv/apps/<slug>/*.log` and is reachable only over
SSH. This is a hard blocker: the phase that deletes the Cloud Run path also
deletes `getLogs`, and without a replacement the dashboard goes blind for every
app at once.

### Crons change meaning silently

The agent's parser accepts `*`, comma lists of integers and `*/N`
(`process.go:198-229`). It rejects ranges (`1-5`), names (`MON`, `JAN`),
`@daily`, and `7` for Sunday. `5/15` parses as `[5]` with the step discarded,
where real cron means 5, 20, 35 and 50. Day-of-month and day-of-week are ANDed
(`process.go:272-278`) where Vixie cron and Cloud Scheduler OR them.

So a cron that migrates with a range or a name **stops firing, and the only trace
is one line in the node's journal** (`main.go:139`). The dialect must cover what
Cloud Scheduler accepted before any cron moves, and an unparseable schedule must
fail the deploy rather than log locally.

There is also a third, independent cron mechanism — dashboard-created Scheduler
jobs that POST the app's own Cloud Run URL (`app/api/apps/[slug]/jobs/route.ts:29-31`).
It has no fleet implementation at all: a fleet app has no Cloud Run URL, creation
returns "app has no URL yet", and existing entries keep POSTing a dead address.

### A failed release stalls the whole node

`RunToCompletion` is called synchronously inside `reconcileOnce`
(`main.go:452`). On failure `a.released[slug]` is not set, so the next pass runs
it again — every 10 seconds, forever, each attempt able to hold the reconcile
goroutine for its hardcoded 30-minute timeout. While it holds, **no other app on
that node is reconciled** (`main.go:280-285`). Needs backoff, an attempt cap, and
to be moved off the reconcile goroutine.

Worker crash-loops have the same shape one level down: restarted immediately, no
backoff, no cap, nothing recorded (`main.go:406-430`).

### Four fields the spec accepts and drops

`instances`, `taskTimeout`, `retries` and `health.expect` pass
`assertEmittable` (`processes.ts:181-186`) and are never emitted
(`fleet-spec.ts:129-160`). `envelope.ts:118-140` puts `processes` in
`NEVER_ASSERTED`, so `assertReached` cannot catch the loss. The visible
consequence: **a worker on the fleet always runs one instance**, however many
were declared.

`ShutdownGrace` is declared (`process.go:60`) and read nowhere; `Stop` sends
`SIGKILL` immediately (`container.go:510`). Implement it or delete the field and
the comment that describes it.

### One test that should exist

`test/fleet-spec.test.ts` parses `type App struct` out of `main.go` and compares
key sets, because a comment claiming the structures matched was wrong for
`secrets` and `processes`. `type Process struct` has no such test. The status
report type will need one too, or this channel reproduces the exact defect that
test exists to prevent.

---

## Phase 2 — The substrate is verified

Runs in parallel with Phase 1. Needs the operator's hands, and nothing downstream
is real until it passes.

1. SSH to the node works. The key at `~/.ssh/google_compute_engine` has a
   forgotten passphrase; `enable-oslogin` is explicitly `FALSE` on the instance,
   so the path is a regenerated key pushed to project metadata.
2. `nft -c -f /etc/nftables.conf` parses. This matters beyond the new rule:
   section 6 of that file ends with `systemctl restart nftables`, so a ruleset
   that fails to parse means the **metadata-server block does not load either** —
   and that block is the only thing stopping a tenant from reading the node's
   service-account token.
3. `cloud-sql-proxy` runs as an enabled unit, ordered before the agent.
4. A sandbox reaches `10.200.0.1:5432`. Entered by hand, connected by hand.
5. The node reboots and all four survive it.
6. One database-backed app deploys from nothing, migrates, writes, reads,
   restarts, and reads back. **Its probe must request a path that touches the
   database** — `epvmx` proved that a started process can refuse every real
   request while serving its homepage happily.

---

## Phase 3 — The funnel widens

Small, and mostly deletion.

- **Stop refusing apps by a string.** The lane is fixed at
  `deploy-pipeline.ts:1866`, before the SPA and Next.js fallback Dockerfiles are
  written at `:1922,1925`. Judge placement on how the app was actually built, not
  on the lane label. This may be most of the population the buildpack refusal
  currently costs.
- **Buildpack.** Add a logging destination to the `--pack` submit
  (`--default-buckets-behavior=regional-user-owned-bucket` or `--gcs-log-dir`)
  and pass the scoped build identity, then route the lane through the shared
  `buildImage()`. The constraint that blocked this is real — commits `8fee071`
  and `84e6ad5`, thirteen minutes apart, record a live deploy failing on it — but
  the inference drawn from it ("no cloudbuild.yaml, therefore no logging
  destination") is not: both flags reach the same call as `--pack`. **Unverified:
  nobody has submitted a live build with that flag combination. Do it on a
  throwaway app before relying on it.** The lane may instead simply be deleted by
  making a failed Dockerfile render fatal; decide when its population is known.
- **Runner decommission, per app.** `RUNNER=0` already means no new deploy takes
  the lane, so this is rehousing existing apps, not changing the pipeline. Apps
  deployed from git can be re-cloned. **Apps deployed by upload cannot** — their
  source exists only as an encrypted bundle in `ready/<slug>/`, keyed per deploy
  and readable only by that app's own revision. There is deliberately no
  `--migrate-all` (`runner-decommission.sh:68-74`). Those apps get asked to
  re-upload or get deleted; there is no third option.
- **Processes.** Reconcile each fleet app's Cloud Run process set to empty, then
  stop touching it. A guard alone leaves worker pools, jobs and Scheduler entries
  running forever.
- **Siblings.** The multi-service block (`deploy-pipeline.ts:3473-3504`) has no
  `toFleet` guard, so a two-service app would get half-fleet, half-Cloud-Run
  `routes`. Place siblings on the node or name multi-service as a refusal.
- **Keep the runtime-version pin.** `RUNTIME_VERSIONS` is held in place by a test
  that reads the runner's Dockerfiles (`plan-deps.test.ts:195-197`). Delete the
  directory without replacing the pin and version drift lands silently.

---

## Phase 4 — The default flips, and Cloud Run goes

`FLEET_APPS` and `FLEET_PLACEMENT` are deleted rather than left switched on: a
flag nobody can turn off is a branch pretending to be a choice.

Then the deletion, which is large and measured:

| File | Lines | Note |
|---|---|---|
| `deploy-pipeline.ts` | 3656 total | 900–1100 removable — an estimate from cited ranges, not a measured diff |
| `gcloud.ts` | 629 | ~85% dead, imported by 19 files — the widest blast radius |
| `lanes.ts` | 364 | **except** `Scale`, `DEFAULT_SCALE`, `withScale`, which the fleet path consumes and which must survive the file |
| `process-deploy.ts` | 407 | |
| `release-job.ts` | 327 | its `proxyWait` is imported by `process-deploy.ts` — both die together |
| `process-plan.ts` | 237 | |

Four test files go outright (~1100 lines); eight need substantial rewriting.

Two traps in the deletion. `resolveSlug` builds its taken-set as live Cloud Run
services **union** Artifact Registry packages (`gcloud.ts:185-230`); dropping the
first half narrows uniqueness checking on a five-character slug space. And
`getLogs`/`getErrors` are what the dashboard shows for every app not yet on a
node — they cannot be deleted before Phase 1's log shipping exists.

Last, the ~40 Cloud Run app services are deleted, and the six of ours remain.

---

## Verification

**Pure functions, in tests.** Runtime choice, connection strings, the status
verdict, the cron dialect, and "did the app answer or did the router" are decided
without a node, a database or a load balancer.

**Two drift tests that read Go source.** One for `type Process struct`, one for
the status report type, mirroring the existing `type App struct` test.

**On a live node, before the pipeline work.** Phase 2's six steps. A measurement,
not an argument.

**The security fix, demonstrated both ways.** A request without the edge header is
refused; the same request with it succeeds. Both against the real load balancer.

**One database-backed app, end to end**, probed on a path that touches the
database.

---

## Risks, stated rather than solved

- **A worker that reports `running` is not a worker that works.** Nothing probes
  a non-web process by design. Two consecutive reports reduce the false green;
  they do not remove it. Still strictly stronger than today's serviceless path,
  which returns success with no evidence at all.
- **Fault misclassified as `node` masks a real app bug.** The cost asymmetry
  favours this direction — a false `node` costs one rolled-back deploy, a false
  `app` costs a repair run with write access to a customer's repository — but
  corroboration against the node-level `dbPath` record is required rather than
  optional.
- **`10.200.0.1` is now load-bearing.** It began as a detail in `network.go` and
  is now part of every database-backed app's configuration.
- **One node.** `fleet-lab-1` is an `n2d-standard-16`; 20 sandboxes use 3.1 GB of
  64 GB, so capacity is not the concern. A reboot taking every customer app at
  once is. A second node is not in this spec and should follow it closely.
- **WebSockets do not work on either runtime.** `forward.ts:53` uses
  `http.request` and `headers.ts:37` drops `connection` and `upgrade`, so no
  upgrade is ever forwarded. SSE works. This predates the migration; it is named
  here so it is not discovered as a regression.

## Not verified — do not repeat as fact

- **Whether any app currently on the fleet is private.** Needs a database query
  nobody can run without `application-default login`.
- **The node-side Cloud SQL proxy has never been started**, and the nftables
  ruleset has never been parsed by `nft -c`.
- **No app has ever been placed on the fleet by the pipeline.** The nineteen
  that moved were cut over by hand with `services/fleet/migrate.sh`.
- **`resolveImageDigest` has never run against `cloud-run-source-deploy` in
  production.** It is mocked in every test.
- **`--pack` with a scoped service account and a logging-destination flag has
  never been submitted.** Documented and flag-compatible; not observed. Whether
  the buildpack lane is taught to build or deleted outright is an **open
  decision**, and the thing that settles it is a count: how many apps reach the
  lane because the Dockerfile render threw. Measure that in Phase 3 before
  choosing.
- **The Shelf layout has never been seen.** The browser extension is not
  connected.
- **No repair-agent run on GPT-5.6 Sol.**
- The repair agent's cost is often quoted as $12–15 a run. That figure is **not
  in the repository**. What the code proves is the mechanism: a Pro-tier model,
  up to 18 steps, up to 3 full rebuild-and-deploy cycles, with `write_file` and
  `run_command` against a customer's checkout.

## The order

| | | |
|---|---|---|
| 0 | Stop the bleeding | hours; depends on nothing |
| 1 | The node becomes operable | the bulk of the work |
| 2 | The substrate is verified | operator's hands; parallel with 1 |
| 3 | The funnel widens | small, mostly deletion |
| 4 | The default flips and Cloud Run goes | large deletion, low risk once 1–3 hold |

Phases 1 and 3 both gate Phase 4, for different reasons. Phase 1 because until
logs leave the node and status reaches the control plane, deleting the Cloud Run
path does not migrate the platform — it blinds it. Phase 3 because deleting a
path still carrying runner apps and multi-service apps leaves them nowhere to go.
Phase 2 gates nothing on paper and everything in practice: it is the only
evidence that any of this runs.

**This spec is a programme, not one implementation plan.** Each phase gets its
own plan under `docs/superpowers/plans/`, written when the phase before it has
landed — except Phase 2, whose steps are operator actions rather than code and
which is written down here in full. Phase 0 is the first plan to write.
