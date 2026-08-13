# The platform, designed as one thing

## Why

Two complaints, and only one of them is the one people say out loud.

**The stated one: it is slow.** Measured on 11 Aug from `deploy_stages`, container
lane, happy path, deploys carrying a real `run_id`, last 30 days (n=25):

| | p50 | note |
|---|---|---|
| **whole deploy** | **238.4 s** | p90 369.1 s |
| `job-cold-start` | 118.3 s | of which `job-launch` is 116.4 s |
| `deploy` (activation) | 80.6 s | `fleet` placement, 25.1 s, nests inside |
| `build` | 54.1 s | Cloud Build end to end |
| `job-dispatch` | 3.8 s | |
| `run-fetch` | 3.7 s | |
| `detect` | 1.0 s | |
| `job-import` | 1.3 s | |
| `render` | 0.4 s | |
| `unpack`, `run-record`, `infer-services` | 0.0 s | |

Everything this platform actually *decides* — reading the repository, choosing a
lane, generating a Dockerfile, splitting a monorepo, unpacking, recording —
sums to about **2.5 seconds out of 238**. The rest is three schedulers that are
not ours, cold-starting something, one after another.

The split of `job-cold-start` into `job-launch` and `job-import`, added on 6 Aug
for exactly this question, is what makes the answer usable: `job-import` — Node
booting and tsx transpiling the whole import tree — is **1.3 s**. Precompiling
the entry point would have bought nothing. All 116 seconds are Cloud Run
scheduling the execution and pulling the control-plane image.

And it is not a spike. By week: 106.1, 103.6, 102.0.

**The unstated one, and the reason the first cannot be fixed piecemeal: the
platform was designed for Cloud Run and had a fleet added to it.** Every
capability question forks by runtime. `lib/deploy-target.ts` exists because 21
call sites independently asked "which target". The database address differs, so
`restateDatabaseAt` exists to repair a sibling stranded on the wrong one.
Workers and crons go to Cloud Run even for an app whose web process is on a
node. `release` is a Cloud Run Job on one runtime and a process in the spec on
the other. Rollback, exec, domain mapping and auto-rollback each differ.

ADR 0001 already decided the fleet is the only target for apps that run a
server. This document does not reopen that. It designs what the platform looks
like when that decision is finished rather than half-applied.

## What this is not

Not a migration plan — that follows. Not a decision about which hosting provider
to buy from; §2 explains why that is deliberately deferred. Not a rewrite: eight
of the eleven decisions below keep something that already exists, and three of
the four open-source candidates evaluated were dropped because the design
removed the need for them.

## The invariants

Five properties everything below is built to preserve. They are not new — four
are already enforced somewhere in this codebase, inconsistently. This design
makes them uniform.

1. **The platform may not lie about its own state.** `assertReached`, absent-vs-
   empty on the wire, `who` declared and never inferred, `since` on a reading,
   `BuildsWindow: durable | unreadable`. A missing measurement must be
   distinguishable from a measurement of nothing.
2. **A data plane must serve without the control plane.** Already true of the
   node router, which reads `routes.json` off local disk. Not true of the edge
   proxy, which reads Postgres with a 30-second cache — the same construction
   that took Railway down for eight hours on 19 May 2026.
3. **The spec carries references, never values.** Already true of secrets.
   Extended.
4. **One implementation per question.** The reason `deploy-target.ts` had to be
   written, and the reason `lib/lanes.ts` had to be written.
5. **Degradation has one shape: nothing moves, nothing stops.** Stated in §5,
   contradicted by §6, resolved in §10.

---

## 1. The unit of execution

**Decision: gVisor sandboxes, one per process.** Unchanged.

The unit is a **process** — `web`, each `worker`, `release` — not an app. This is
what makes workers first-class rather than bolted on, and it is currently
violated by workers deploying to Cloud Run while their web process runs on a
node.

**Why not Firecracker.** Fly's model is better on isolation and its containerd
path works, where ours does not: on containerd 1.7.29 and 2.2.6 with gVisor
release-20260727.0, every container started through `io.containerd.runsc.v1`
reaches `created` and never `running`. That is why the agent drives `runsc`
directly and owns its own supervisor, cgroups, namespaces and freeze path. That
cost is **already paid**. Moving to Firecracker means paying it again, plus
building image-to-rootfs conversion, to buy isolation we are not currently short
of. Revisit only on a syscall-compatibility wall or an external audit
requirement.

**Constrains:** the artifact must be an OCI image, because the sandbox is built
from a containerd snapshot. "Deploy", at the node, means changing a process's
image or command.

## 2. Where the unit lives

**Decision: at least three nodes across at least two failure domains. A
reconciler is mandatory. The hosting provider is deliberately deferred.**

Three, not two: with two, losing one puts everything on the survivor and the
spread policy has no room left to be a policy.

**What the investigation found.** `chooseNode` spreads by committed memory,
refuses a node past 4× overcommit, honours `drain` and 90-second liveness, and
deliberately does not bin-pack — "headroom on every node is what lets one node
absorb another's apps when one dies". The policy is right and it is written
down.

**There is nothing to absorb with.** `last_seen` is read only as a *filter* — in
`chooseNode`, `peersFor`, `nodeFaultFor`. Nothing walks a dead node's placements
and moves them. There is no periodic process on the control plane at all: no
cron, no worker, no `setInterval`. The control plane is entirely reactive; it
acts only when a deploy arrives. A node that dies at night takes its apps with
it until someone redeploys them by hand.

`peersFor` does filter dead nodes out, so live nodes stop forwarding to the
corpse. Routing stops pointing at it. Nothing restarts what it was running.

**Why the provider decision is deferred.** A node depends on GCE three ways: the
metadata server's token (for both Artifact Registry pulls and Secret Manager),
cloud-sql-proxy's adjacency to the shared instance, and the ops agent shipping to
Cloud Logging. Until those are cut, "move to dedicated servers" is not a change
of invoice, it is a rewrite of three subsystems. They are being cut anyway, for
the reason in invariant 2. After that, the provider is a decision that can be
made on numbers.

**Constrains:** the reconciler needs to express "move this app from node A to
node B". `unplaceApp` deletes every row for a slug and cannot say it. §5 fixes
that.

## 3. Source to artifact

**Decision: keep our own stack detection; emit BuildKit LLB instead of a
Dockerfile; move the builder off Cloud Build onto a long-lived BuildKit we own.
The artifact is modelled as a pair — base and code — and implemented as a single
image first.**

**What the measurement says.** `build` is 54 s of 238. Eliminating the build
entirely buys 23%. It is not today's problem — and it becomes 90% of the problem
the moment the cold starts are gone. Inside those 54 seconds is the same disease:
Cloud Build schedules a worker, pulls a builder image, pulls a base image, and
only then does BuildKit touch the code.

**The observation that decides it.** We already built the fast path and turned it
off. The `runner` lane installed dependencies once at deploy time, uploaded a
ready bundle, and pointed a shared prebuilt image at it. That is the base-plus-
code shape. `RUNNER=0` today, and the code records why it was replaced: the
runner had **two images**, Node and Python, "because someone built two
Dockerfiles". A Go app, or one pinning a version, did not fit. The generated
Dockerfile removed that limit — "the platform stops being the thing that decides
what an app may run on".

**The runner was killed for coverage, not for speed. On speed it won.**

So the target is the runner's speed without the runner's coverage limit, and the
way there is that the "base" is not two hand-built images but **this app's own
base, rebuilt only when its dependencies change**. Which, looked at squarely, is
an honest layer cache. We have one — `cachedBuildConfig` with
`--cache-from type=registry` — but it lives in a registry and is pulled over the
network onto a clean Cloud Build worker every time. A cache you must download in
full is not a cache; it is a slow registry.

**Railpack** is adopted here: Go, BuildKit LLB, mise. Its own numbers on leaving
Nixpacks are 38% smaller Node base images and 77% smaller Python. It already
solves build secrets (BuildKit secrets, absent from build logs) and cache
invalidation by hashing environment values.

**What must be ported, not lost:** `build-hints` — apt packages learned from this
app's real failures and fed back into the next render — and
`publicUrlBuildArgs`, which tells the build the address the app will answer on.
Railpack has neither. The first is a feedback loop nobody upstream has, and it is
worth contributing back.

**Rejected: buildpacks.** Google's builder has no Rust, Elixir, Deno or Bun, and
its Python is 3.13 and 3.14 only — which is how an app pinning 3.12 failed
*after* being routed correctly.

## 4. Artifact to machine

**Decision: pull from a registry, cached locally on a disk that survives a
reboot, through a per-site mirror once there is more than one node.**

The pull sits on the critical path of three things, not one: a deploy, a node
reboot or replacement, and a re-placement by the reconciler after a node dies.
Time-to-pull is therefore a **recovery** number. Full recovery from node loss is
detect + re-place + pull + boot + probe.

**We are designing this one blind.** `fleet-pull` and `fleet-boot` have **zero
rows**. Both sides are built — `StartTiming` in `container.go`,
`recordStartTiming` in `fleet.ts:430`, commit `4afedde` titled "fleet agent +
control plane: pull and boot time reach deploy_stages" — and the node runs an
older agent, because **the agent has no deploy path**. ADR 0002 named that gap a
year ago and routed around it. It has now cost us the measurement for this
decision.

**Second finding: the content store is on the wrong disk.** containerd's `root`
is left at its default, so images live on the boot disk while the local SSD
mounted specifically for rebuildable state holds only bundles and overlays. The
boot disk carries `autoDelete=true`, so replacing an instance loses every image;
and layer unpacking, the most I/O-heavy part of a start, runs on the slower disk.

**Resolution:** the content store belongs on a disk that survives a reboot, and a
per-site mirror makes re-pulling cheap enough that this costs little. These two
are one decision, not two.

**Rejected: P2P distribution** (Dragonfly, Kraken) — pays off at dozens of nodes.
**Deferred, not closed: lazy loading** (stargz, SOCI, Nydus) — it is what pairs
with §3's base-plus-code split to make start time independent of image size.
Nothing in this design may assume "pull fully, then start".

## 5. Who decides where it runs

**Decision: three concepts — an immutable release, a desired state on the app,
and a leased placement per instance. One placement function, called by both the
deploy and the reconciler. Replicas modelled now, defaulted to one.**

`fleet_placements` is `(slug, node) → spec`, overwritten. From that:

- **No version.** The node compares fields by hand — image, command, env,
  `secretsVersion`. Two concurrent deploys race on one row with no arbiter.
- **No history.** `rollback` returns 501 on the fleet, honestly. `rewind`, `undo`
  and **`shadow`** go with it — and shadow is what `Ask`-that-changes needs.
- **`unplaceApp` deletes every row for a slug.** "Remove from A, keep on B" is
  inexpressible, so there is no migration, no replica and no drain — though the
  primary key `(slug, node)` permits all three.
- **No lease.** Nothing stops the control plane re-placing a live but silent
  node's apps and producing two copies writing to one database.

**Release** — immutable, written once per successful build: app, version,
artifact, spec. This is the timeline. The artifact is the pair from §3, both
fields pointing at one digest today.

**Desired** — two columns on `apps`: which release, how many instances. Not a
table; one row per app is enough.

**Placement** — instance `i` of app X, on node A, running release V, lease valid
until T. One row per instance.

Separating desired from actual is what makes a rollout **expressible**: during
one, some instances are on the new release and some on the old, and that is a
correct state rather than a divergence. No such state exists today, which is why
a fleet deploy is stop-then-start — that is, downtime.

**The lease** is what makes the reconciler safe. Its meaning is defined
precisely in §10, because the obvious reading of it is wrong.

**Replicas** are per process kind. A queue-consuming worker sometimes tolerates
two; a cron never does; a release never does. Default one, `web` may take two by
explicit opt-in. Schema now, because retrofitting it later is the expensive move.

**Rejected: leader election among nodes for the reconciler.** It would remove the
control plane from the recovery path — but it needs nodes to write the placement
table, and a node is a machine running other people's code whose service account
already reads every secret in the project. The lease already reduces the cost of
the control plane being down to "cannot move", which is degradation rather than
failure.

## 6. How a machine learns what to run

**Decision: long-poll carrying a per-node generation; a full response only when
the generation has moved. Lease two minutes, heartbeat fifteen seconds, TTL
carried in the spec.**

Today `POST /api/fleet/sync` returns the **full** desired set every ten seconds.
Three problems, and only one is about scale: load is O(nodes × apps) forever,
against state that changes every few minutes; up to ten seconds of deploy
latency; and the node cannot say what it already has.

**The lease makes the heartbeat mandatory**, which removes a whole class of
options — gossip-replicated local state in the style of Fly's Corrosion buys
"never contact the centre", and after §5 we must contact it anyway. Corrosion
solves a problem this design does not have.

So the question is only what the mandatory round trip carries.

One connection does both jobs: it renews the lease on receipt, and holds open
until either the node's generation is stale or the window expires.

**The response is full, not a delta.** A lost delta is permanent divergence. A
full response on a changed generation keeps the self-healing property of polling
and drops its cost: almost every response is empty, and any response carrying
data is complete. A node offline for a week returns with an old generation and
receives the whole picture — correct by construction.

**The generation is per node.** A global counter wakes the whole fleet on any
change anywhere. The placement function increments the counter of the node it
touched.

Fifteen-second heartbeat against a two-minute lease is eight attempts before
expiry: it survives everything short of a real partition, and the worst-case
recovery is about two and a half minutes. TTL lives in the spec so it can be
changed without shipping an agent — which matters, because the agent has no
deploy path.

The reverse direction is kept as built. `ProcessFault` and `ProcessState` already
distinguish an absent field from an empty one, and `ReportNow` already reports
immediately after a placement instead of waiting for the next poll.

## 7. How traffic finds the app

**Decision: the edge stays a separate trust boundary and becomes a second
consumer of the same desired-state channel. Designed stateless so a second copy
is a matter of starting one; one edge per site once there is a second site.**

**The edge is the Railway failure, verbatim.** `lookupApp` caches for 30 seconds
and then reads Postgres. Postgres unreachable for longer and `*.supersonic.cv`
stops resolving **for every app at once**, however healthy the nodes are.

The awkward part is that **the node router already has the property the edge
lacks**: it reads `routes.json` off local disk and forwards to peers, under a
comment that states the principle exactly — a control plane that is down must not
be able to stop a node serving traffic. The layer in front of everything does not
have it; the layer behind it does.

**Rejected: collapsing the edge into the node router.** It removes a hop and a
service, and it puts sessions and `AUTH_SECRET` on a machine running tenant code
whose service account already reads every secret in the project. That is not an
optimisation, it is the removal of a trust boundary.

The node asks "what should I run". The edge asks "where does traffic go". Same
transport, same generation semantics, same locally durable snapshot; different
projection. One mechanism serving two consumers has nothing to drift.

Three consequences fall out without extra work:

- **Replicas get balanced.** The edge sees a list of placements per slug rather
  than one `run_url`, which today has nowhere to put a second instance.
- **The x-ray's live measurement moves to the node** (§11), which removes the
  `min-instances=1` constraint and lets the edge scale out.
- **TLS stops being an architectural question** and becomes an operational one —
  still a blocker, since an edge without TLS is not an edge, but it is fixed by
  moving DNS somewhere a TXT record can be written, not by changing this design.

## 8. Secrets, configuration and data

**Decision: keep references-never-values. Replace project-wide Secret Manager
access with our own broker that authorises by lease. Volumes pin an app to a
node, and the placement model must be able to say so.**

**What is already right and stays:** the spec carries secret *names*; the node
resolves them at start; values never touch node disk, never reach a log, and
never enter `config.json`, which is readable inside the sandbox. A secret that
cannot be resolved **fails the start** — because an app that comes up without its
`DATABASE_URL` fails every request while passing a health check on `/`. And
`secretsVersion` is the one field that moves when a value does, since names
resolve to `versions/latest` and the spec would otherwise be byte-identical.

**What is wrong:** `secretmanager.secretAccessor` is granted project-wide and
unconditioned, so one sandbox escape reads every tenant's database password. The
narrow version existed and was widened deliberately on 5 Aug, because a
per-deploy binding only covers apps deployed since it was introduced. What stands
between that and disaster is the nftables uid rule in `provision.sh`, now
load-bearing for the whole fleet's secrets.

**The broker.** The node presents itself and the app it is starting. The broker
asks: is that app placed on that node right now, with a live lease? Three things
follow:

- the blast radius collapses from "the project" to "apps currently placed on this
  node", checked instantly against our own table rather than by an IAM condition
  with propagation delay;
- **the lease from §5 becomes an authorisation primitive** — a node that lost its
  lease cannot fetch secrets, which is exactly the wanted behaviour;
- the dependency becomes "a Supersonic service", replicable across our own
  failure domains, rather than one cloud's metadata server.

**The conflict, resolved deliberately.** §4 decided a node caches locally and can
start what it has run before without the network. This section forbids secret
values on node disk. Both cannot hold: a cold boot with no network starts nothing
that has a database.

**Resolution: accept the dependency.** A cold boot needs the broker. This affects
cold boot only — running apps keep running through both a control-plane outage
and a broker outage. Encrypting a node-side cache under a vTPM key was rejected:
it solves the rare case (simultaneous cold boot and broker outage) at the price of
hardware binding, which §2 specifically deferred to keep the provider decision
open. And "apps do not stop, new ones do not start" is the same degradation shape
already accepted for the reconciler; identical shapes are easier to reason about
and easier to test.

**Volumes pin.** `/srv/apps/<slug>/data` is bind-mounted from a disk nothing
replicates, which conflicts directly with the reconciler wanting to move apps.
Replication is not built. The placement model must be able to express "this
cannot move" — expressing it is required now; replicating is not.

**Noted and deferred:** one shared Cloud SQL instance for every tenant is a
concentration risk and the third thread to GCP. Moving it is its own project and
blocks nothing above. §10 splits the platform's own database off it.

## 9. The lifecycle of a version

**Decision: rolling by temporary over-provisioning; readiness reported by the
node; rollback is one write; the deploy returns a handle and the client watches.**

**Zero downtime does not require permanent replicas — it requires temporary
headroom.** A new instance comes up beside the old, passes its health check,
takes traffic; the old one drains. And the headroom exists **by construction**:
`chooseNode` refuses to bin-pack precisely so that a node can absorb another's
apps. The policy bought for absorbing failure pays for rollout as well. One
mechanism, two jobs.

The exception is an app pinned by a volume (§8): it can only roll on its own
machine, and where there is no room, stop-then-start remains. That is a stated
limit, not a discovered one.

**Readiness is reported, not probed.** Today the control plane probes from
outside and decides — which is why a redeploy's probe could be answered by the
version being replaced, worked around by additionally consulting the node's
report and comparing image and command. In this model that stops being a
workaround: **the node reports readiness**, because it is the only thing that
observes the process and knows which release is in it. "Which version answered"
is no longer ambiguous.

**Rollback is `apps.desired_release = previous`.** The reconciler does the rest,
through the same function a deploy uses. `rollback`, `rewind` and `undo` stop
being stubs returning 501.

It is a rollback of **code, not schema**. A release that ran a migration is not
undone by pointing at an older image. This is true everywhere and must be said in
the interface rather than discovered. The same constraint governs rolling: while
new instances come up the old ones are still serving, so **a migration must be
compatible with the running release**. The agent already blocks everything else
until a release succeeds; what is missing is telling the author that an
incompatible migration is what makes rolling unsafe.

**Shadow falls out.** A placement of release V+1, marked, with the edge mirroring
requests and discarding responses. Placements can already be plural, the edge
already reads them, readiness is already a field. What was blocked by the schema
is now blocked only by the decision to switch it on.

**The deploy, end to end:**

1. build → an immutable release row
2. `apps.desired_release = V`
3. the placement function creates placements for V — the same function the
   reconciler calls
4. nodes see a new generation, pull, start, **report ready**
5. the edge sees ready placements for V and moves traffic
6. old placements drain and are removed
7. readiness does not arrive within budget → desired reverts, V's placements are
   removed

Step 7 is the **same write** as the success path, in the other direction. The
in-memory restore of a previous spec disappears, and with it the class of bugs
that begins "what if the process died between reading and writing".

**The client waits, not the server.** `supersonic ship` returns when the new
version is serving — but by polling durable state, not by holding a connection.
A dropped connection then breaks nothing, a repeated command resumes watching,
and "the deploy survived a closed laptop" stops needing machinery of its own: the
durable event log already is that machinery.

## 10. What must survive the control plane

### The contradiction, and its resolution

§5 promised: *control plane down → nothing moves, nothing stops.* Its mechanism
was that a node stops itself when it cannot renew its lease. §6 put lease renewal
on the heartbeat to the control plane.

Together: **control plane down for two minutes → no node renews → every node
stops every app.** That is precisely the catastrophe this whole design exists to
prevent, self-inflicted and on a timer.

**Resolution: lease expiry authorises the control plane to re-place. It is not an
instruction to the node to stop.**

The node keeps serving. From its own vantage point it cannot distinguish "the
centre died" from "I was cut off", and assuming the worst turns any control-plane
fault into a platform outage. kubelet and the Nomad client behave the same way:
tasks keep running when servers are unreachable.

Two things close the two-copies hazard that this reopens:

**Quorum on the control plane side.** The reconciler re-places from a silent node
only while a **majority of registered, non-draining nodes have reported within
the lease window**. Below that, the isolated party is probably the control plane
itself, and the correct action is none. Stated as a threshold rather than as
"sees the fleet as healthy", because the latter has two readings and the
difference between them is whether a three-node fleet evicts on one silence or
on two.

The degenerate case is deliberate: with a single node, a majority is that node,
so a lone node going silent never triggers eviction — there is nowhere to move it
to anyway, and `chooseNode` would return null.

**Two nodes is the awkward count, and it is the count actually running.** This
paragraph reasoned about one and about three and skipped two; measured on 11 Aug,
the fleet is `fleet-lab-1` (22 sandboxes) and `fleet-lab-2` (8), both on agent
`e6f6314`. A majority of two is two, so ONE silent node puts the fleet below the
threshold and eviction never fires — for either node, at any silence. The
two-node fleet has the single-node behaviour while paying for two machines.

That is not an argument for lowering the threshold. Lowering it to "any one node
reported" makes a two-node fleet evict on a partition in whichever direction the
control plane happens to be reachable from, which is the two-copies hazard this
section exists to close. It is an argument that **the eviction guarantee arrives
at three nodes, not at two**, and that §10 should say so rather than leaving the
reader to derive it. Until then, a silent node is a human's problem, and the
honest thing is for the reconciler to log that it is holding rather than to look
like it is deciding.

**A database lock for singleton processes.** Where two copies genuinely hurt — a
queue-consuming worker, a bot polling `getUpdates`, both already named in this
codebase as things that do not survive being run twice — the process takes a lock
at start. A mistaken re-placement then cannot double-run it: the second instance
does not get the lock and waits. A stateless web process needs no lock; two
copies for a minute is not an incident.

### Degradation

| Failure | Running apps | Deploys | Re-placement | Traffic |
|---|---|---|---|---|
| Control plane | run | no | no | served, from the edge snapshot |
| Postgres | run | no | no | served |
| One node | its apps stop | yes | yes, after lease + quorum | served |
| One site | its apps stop | yes | if capacity exists | served, if the edge is per-site |
| Secret broker | run | no new starts with secrets | partial | served |
| Registry | run | no | **yes**, onto a node that has the image | served |
| Build plane | run | no | yes | served |

The registry row is what §4's local cache buys, and this is where it pays.

### The remaining single point of failure

**Postgres**, and worse than it looks, twice.

The broker in §8 authorises by lease, and the lease lives in Postgres. Postgres
down therefore means **no app starts anywhere**, even one whose image is already
cached. Mitigated by the broker's check being read-only: serve it from a replica.

And — verified while taking the measurements in this document — **the platform's
own database shares an instance with every tenant's.** `supersonic_platform` and
what `provisionPostgres` creates via `--instance=supersonic-shared-pg` are the
same server. A tenant running a heavy query competes with the table the edge
reads routes from.

**Decision: split the platform database onto its own instance now; replicate it
across failure domains later.** The split is an evening's work and changes no
code, only a connection string, and it removes the worst part — sharing resources
with tenant load. Replication is an order of magnitude more expensive and only
means something once a second site exists; replicating into the same failure
domain is a backup, not resilience. Railway's own remediation after 19 May was
the same sentence: extend the database shards across providers.

### Capacity arithmetic

Failure domains oblige headroom, or they are decorative:

- **two sites** — each at most 50%, or the survivor cannot take the other
- **three sites** — each at most 67%

This is the direct price of §2 and is better stated before capacity runs out.

## 11. How we know what happened

**Decision: measurement moves to the node and rides the existing sync; the
reconciler reports what it sees; bounded minute rollups, thirty days, each
carrying the window it is true for.**

**What works and stays:** `deploy_stages` — which is what answered the question
at the top of this document; `deploy_events` as a durable log the stream is a
view over; `deploy_failures` with blame classified in code rather than by a model;
`builds` with `who`; the node's fault and running reports.

**What is missing.** The fleet is blind exactly where this design invests, because
the agent has no deploy path — the third appearance of one cause. The x-ray keeps
nothing, so "what happened yesterday" has no answer and `min-instances=1` is
forced. Actual resource use is recorded nowhere, though placement is done on
*committed* memory and the code itself notes 25 sandboxes committed to 50 GiB
using about 3 — so limits cannot be tightened, leaks cannot be seen, and nothing
can be billed by use. And nothing watches: `zpjsb` has been stuck in `deploying`
since 2 Aug, noticed by a human reading a handoff.

**Measurement moves to the node router.** It sees every request to its own apps,
it is naturally sharded, and it survives an edge release. The edge keeps
measuring what only it sees — refusals, the room, requests for unplaced slugs.
Different facts, not a duplicate.

**Rollups ride the sync.** The heartbeat already carries facts about processes;
a per-minute traffic summary is the same shape and needs no new pipe. Bounded as
the in-memory version already is — top-N paths plus a total, **and a dropped
counter**, because silently truncating is a lie and this codebase already refuses
to tell it.

**Memory and CPU ride with it.** The node already measures `memory.current` —
that is where 64–76 MB comes from. Sending it is nearly free and unlocks
right-sizing, leak detection and, if wanted, billing by use.

**The reconciler watches.** It already walks the whole fleet on a clock. Give it
a second job: say when something has been wrong longer than it should be. Not an
alerting system — a reconciler saying what it sees.

**Tracing: not now.** One request id propagated edge → node → app log gives most
of the value for almost nothing. Full tracing is its own project.

**Prerequisite, not a step:** everything node-side is dark until the agent has a
deploy path.

---

## Current against decided

| | Today | Decided |
|---|---|---|
| Tenant runtime | Cloud Run **and** fleet | fleet only; Cloud Run keeps the control plane and, for now, builds |
| Unit | process on fleet, service on Cloud Run | process, everywhere |
| Nodes | one | ≥3 across ≥2 failure domains |
| Node failure | nothing happens | reconciler re-places after lease + quorum |
| Build | generated Dockerfile, Cloud Build | LLB via Railpack, on a BuildKit we own |
| Artifact | `image:digest` | release row, `(base, code)` |
| Content store | boot disk | reboot-surviving disk + per-site mirror |
| Placement | `(slug, node) → spec`, overwritten | release + desired + leased placement per instance |
| History | none | immutable releases |
| Rollback | 501 on fleet | one write |
| Rollout | stop-then-start | rolling into existing headroom |
| Readiness | probed from outside | reported by the node |
| Desired state | full snapshot every 10 s | long-poll, per-node generation, full only on change |
| Edge routing | Postgres, 30 s cache | local snapshot from the same channel |
| Secrets | project-wide accessor | broker authorising by lease |
| Volumes | pin, unstated | pin, expressed in the model |
| Platform DB | shares an instance with tenants | its own instance |
| Watching | nothing | the reconciler |

## Where the 238 seconds goes

Stated explicitly, because speed is the complaint that gets voiced and the order
of work below does not obviously address it. It does, but not where a reader
would look first.

| Block | Today | Removed by | What is left |
|---|---|---|---|
| `job-cold-start` | 118 s | items 4 + 5 | nothing — there is no per-deploy container to start |
| `deploy` activation | 81 s | items 5, 6, 9 | the pull and the boot, which are real work |
| `build` | 54 s | item 8 | the app's own install and build, and only when its dependencies changed |
| our own logic | 2.5 s | — | 2.5 s |

The 118 seconds exist for one reason: `DEPLOY_JOB=1` runs the pipeline inside a
Cloud Run Job, and it needs a container of its own because it is a *procedure*
lasting minutes. Once §9 turns the deploy into build → write a release → set
desired, what remains is seconds of database work with no container to
cold-start. The build still needs somewhere to run, and item 8 gives it a
long-lived BuildKit — warm, not started per deploy.

Of the activation, the outside-in probe disappears (readiness is reported by the
node, §9) and the up-to-ten-second poll delay disappears (long-poll, item 6).
What is left is a genuine image pull and sandbox boot, which the base-plus-code
split and a local layer cache attack directly.

**No number is promised here.** The measurement to compare against does not exist
yet: `fleet-pull` and `fleet-boot` have zero rows, and they will not have rows
until item 1 ships. Promising a target before the instrument works would be the
same mistake as reading the doc comments instead of the table.

**The first three items buy no speed at all.** They buy the ability to measure,
the removal of a known outage mode, and an evening's cheap risk reduction. That
is worth saying plainly rather than letting it be discovered.

## Order of work

Dependency order, not priority order. Each entry is a separate spec.

**Status as of 12 Aug.** Items 1, 2, 4, 5 and 6 are done and in production; the
reconciler runs on a Cloud Scheduler job every minute. What each of them turned
up on the way is recorded below the list, because three of the findings changed
the design rather than merely delaying it.

1. **A deploy path for the agent.** Everything node-side is dark until this
   exists, and it has now blocked three separate things.
2. **The edge's local snapshot.** Closes the Railway failure mode. Independent of
   everything else; the largest resilience gain per unit of work.
3. **Split the platform database off the shared instance.** An evening, no code.
4. **The placement model** — releases, desired, leased placements, generations.
   The one expensive schema change; everything in §5, §9 and §10 waits on it.
5. **The reconciler**, with quorum and singleton locks.
6. **Long-poll sync** with per-node generations.
7. **Workers and crons off Cloud Run** onto the node. *Done. Witnessed in
   production: `rtmsw--nightly` and `izuvx--nightly` fire and finish every ten
   minutes on `fleet-lab-2`.*
8. **The build plane** — Railpack, our own BuildKit, local cache. *Done.
   Railpack is the default builder; `buildkit-1` runs the daemon and the deploy
   job builds against it directly.*
9. **The secret broker.** *Done. The grant was removed on 12 Aug 00:31 UTC and
   the next cron firing at 00:40:02 resolved its secrets through the broker.*
10. **Node three**, then the provider decision. *Done. `fleet-lab-3` is in
    `us-central1-b`, so the fleet also spans two failure domains for the first
    time, and quorum can evict.*

### The artifact pair, measured on 13 Aug, and why it stays one image

§3 decided the artifact is "modelled as a pair — base and code — and implemented
as a single image first". `recordRelease` writes the same digest into
`base_image` and `code_image`, which is that first implementation and not an
unfinished one.

Splitting it would buy nothing today. What the pair was FOR is stated in §3: Cloud
Build scheduled a worker, pulled a builder image, pulled a base image, and only
then touched the code — "a cache you must download in full is not a cache; it is
a slow registry". The long-lived BuildKit we own has a local cache, and the
numbers moved accordingly.

    build   3.4s p50, 5.7s p90     (54s of 238 when §3 was written)
    fleet   25.1s p50, 30.2s p90
    total   64.6s p50, 84.8s p90   (238s baseline)

Measured over a day of real deploys from `deploy_stages`, and separately with a
stopwatch on an app with three npm dependencies where only the source changed:
4 seconds of build inside a 38-second deploy.

WHAT THE MEASUREMENT POINTS AT INSTEAD is `fleet-pull`: 0.9s at p50 and 41.8s at
p90. The image is pulled onto a node, and the tail is where a deploy's time now
goes. That is §4's row — "cached locally on a disk that survives a reboot,
through a per-site mirror once there is more than one node" — and it is the next
thing worth doing for deploy speed, not the artifact split.

### Item 8, half done, and the half that matters is the other one

**§3 said "emit BuildKit LLB instead of a Dockerfile". We do not have to.**
Railpack ships as a BuildKit *frontend*, so the plan is executed by any BuildKit
— including the one our existing buildx lane already starts per build. The whole
integration is one flag and one filename:

```
docker buildx build --build-arg BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend \
  -f railpack-plan.json .
```

`buildkitBuildConfig` already threaded both `-f` and `--build-arg`, so the Cloud
Build config needed no change at all. Writing LLB ourselves would have been work
done to reach a place we could already stand in.

**The split that fell out of it.** Railpack's schema has no `release`, no
`framework`, no `database`, no confidence. Those are not gaps — they are the
platform layer, which Railway also keeps above Railpack. So `detect()` stays and
`lib/railpack.ts` is the seam. Railpack owns *how to build*; we keep *what this
app is*. That is a smaller change than "replace lib/dockerfile.ts" and a more
defensible one.

**Where we may overrule it:** only on `confidence: "certain"` — the repo or the
user said so in as many words. Overruling from our own framework-signal guess
would keep us owning the answer we are adopting Railpack to stop owning.

**What is NOT ported, stated plainly.** `build-hints` maps cleanly onto
`buildAptPackages` and is carried. `publicUrlBuildArgs` is not: it learns which
address variables a build will hear by reading `ARG` declarations, and a plan
declares none. An app whose bundle needs `VITE_API_URL` gets silence on this
lane — the "signup form posts to localhost:8000" failure. `buildEnv` in
supersonic.json is the working substitute and the deploy log says so. Closing it
means learning those names from the source instead, which is a port, not a line.

**And the speed is still in the other half.** Build is 54 s of the measured
238 s, and Railpack alone does not remove it: the cache is still
`--cache-from type=registry` pulled onto a clean Cloud Build worker, which §3
already called "not a cache; a slow registry". The long-lived BuildKit with a
local cache is what collects that, and it is infrastructure that costs money, so
it is a decision rather than a commit. Railpack landing first is still the right
order — it is the part that makes the warm builder worth having.

### Item 7, written but never witnessed

An audit on 12 Aug found both sides present, which is not the same as working:

- the control plane builds `processes` into the placement spec (`buildAppSpec`),
  and `FLEET_OWNS_PROCESSES` is a named empty list so a fleet app declares
  nothing to Cloud Run while the orphan pass removes the worker-pools and jobs
  it used to have;
- the agent has `web`/`worker`/`cron`/`release`, a cron runner with schedules,
  timezones and a consecutive-failure tracker.

**Nothing here proves it runs.** Reading code establishes that somebody wrote
it. The proof this item is waiting for is one deploy of `examples/shapes/crm`
onto the fleet — web, a `release` that migrates, and a `nightly` on `*/10` in
`Asia/Almaty`, which is every kind at once and is why that fixture exists. Until
that has been watched, this item stays open no matter how complete the code
looks, because the last four findings in this document were all in code that
looked complete.

### What the build plane measures, on 12 Aug

The first build on `buildkit-1` was cold: it pulled the Railpack frontend, the
Go toolchain through mise and the base images, and took the daemon's cache from
120 KB to 2.0 GB. The second deploy of the same app took **101 s end to end** —
from the CLI command to the app answering — and left the cache at 2.0 GB, which
is the whole claim in one number: it downloaded nothing.

Against the 238 s p50 this document opens with. The comparison is honest about
its own limits: a different app, one sample, and the job cold start varies. What
it is not is ambiguous about where the remaining time goes.

**The build has stopped being the interesting part.** In the deploy before it,
`Building on the fleet's own BuildKit` is logged at 03:04:07 and the app prints
`listening on 8080` at 03:04:26 — nineteen seconds for build, push, placement
and start together, on a Go app with a migration. The execution had begun at
03:02:00. So roughly two of every two-and-a-bit minutes is still Cloud Run
scheduling a container to run the pipeline in, exactly as the table at the top
of this document said in a week when the build looked like the problem.

That is §9's work, not §3's: once a deploy is "build → write a release → set
desired", there is no per-deploy container to cold-start. The build plane
removed the block it was aimed at and made the next one impossible to miss.

### The whole path, measured end to end on 12 Aug

79 seconds from `supersonic ship` to the app answering:

```
04:09:26  ship
04:10:20  release runs on the node, before the app starts
04:10:36  migrated
04:10:45  listening on 8080
```

Against the 238 s p50 this document opens with. What that one deploy exercised,
in order: dispatch to the warm worker instead of a Cloud Run Job execution;
Railpack planning the build; the build running on `buildkit-1` against a warm
local cache (`#5 CACHED`); a push by digest; placement through the release and
lease model; the release migration running in a sandbox on a node; and every
secret in it resolved through the broker by a node whose service account cannot
read Secret Manager at all.

Six of the eleven decisions in this document, in one command, on a fleet that
also now spans two zones.

**The honest limits.** One app, one sample, on a Go service small enough that
its own compile is not the story. The number to watch is not 79 — it is that
`job-cold-start`, 118 s of the original 238, no longer appears at all, because
there is no per-deploy container to start.

### The night of 11–12 Aug, and four things it found

Items 7, 8, 9 and 10 closed in one session. What is worth keeping is not that
they closed but what closing them turned up, because none of it was in the plan.

**The fleet had one door.** `fleet-backend` had a single instance group holding
`fleet-lab-1`. `fleet-lab-2` was healthy, held 26 routes, and received traffic
only by being forwarded to from the other node — so losing `fleet-lab-1` would
have taken every app down while a perfectly good node sat behind no load
balancer. Both are backends now, and `fleet-lab-3` joins from `us-central1-b`,
which is also the first time this fleet has spanned two zones.

**`provision.sh` had never once started the SQL proxy.** Under `set -euo
pipefail`,

    if systemctl list-unit-files | grep -q '^cloud-sql-proxy'; then

is FALSE exactly when the unit EXISTS: `grep -q` exits at the first match, the
producer takes SIGPIPE and exits 141, and `pipefail` promotes that to the
pipeline's status. So the block that starts the proxy was skipped on every run,
and the new node could not run a single app with a database. The comment above
that block already described this failure, on a node it already named. Three
more instances of the same shape were found and removed; one of them would have
made the fleet silently stop collecting agent updates.

**The agent outran its own control plane.** Nodes collect a new agent every two
minutes on a systemd timer; the broker's route and the agent that calls it
landed as two independently-triggered workflows. The agent won, and three apps
failed their releases against a 404 that was the Next.js shell. CI now blocks
the agent publish until the control plane at the same commit is live.

**The same question, asked in three variables.** `hasDockerfile`,
`hasDockerfileNow` and `useDockerBuild` all answer "is there something here that
builds a container". Teaching the first about Railpack plans and not the second
produced a deploy that built an image correctly and then refused itself with
"this lane has no image of its own to build".

Every one of these was in code that looked complete, which is the note this
document has been making about item 7 for a day.

### Item 9, and the one step that actually removes the risk

Both halves are in production and **nothing is safer yet**, which is worth
stating plainly rather than letting the commits imply otherwise. The broker
answers, the agent asks it, and the node's service account still holds
`secretmanager.secretAccessor` project-wide. Until that binding is removed the
old path remains open and an escape still reads everything.

**The remaining step, in order, because the order is the whole risk:**

1. Roll the agent carrying `broker.go` onto both nodes.
2. Watch a real start resolve through the broker — the agent logs
   `secrets resolve through …` once at boot, and a failure is loud because there
   is no fallback.
3. **Then** remove `roles/secretmanager.secretAccessor` from the node service
   account.

Doing 3 before 2 takes every app that restarts with it. Doing 1 and 2 and never
doing 3 is where this work quietly amounts to nothing.

**Verified in production on 12 Aug**, against a real placement and without
fetching a single secret value — asking for a key that does not exist separates
"was I authorised" from "does the secret exist", and the two answers differ:

| asked | answer |
|---|---|
| `q6doa` on `fleet-lab-1`, absent key | Secret Manager's own 404 — *placement and lease passed* |
| `q6doa` on `fleet-lab-2` | `q6doa is not placed on fleet-lab-2` |
| `q6doa` asking for `app-anatf-DATABASE_URL` | `not q6doa's to read` |
| `q6doa` asking for `fleet-edge-secret` | `not q6doa's to read` |
| `q6doa` asking for `app-q6doaX-DATABASE_URL` | `not q6doa's to read` — the prefix attack |

**Two checks, not one.** Placement answers "may this node act for `shop`" and
says nothing about which ids the request lists. Without the second, a node
holding `shop` asks for `app-blog-DATABASE_URL` and the broker fetches it with
the *control plane's* credentials — broader than the node's have ever been. A
smaller blast radius was the goal; that would have been a larger one with an
audit trail.

**What it is worth today, exactly.** `FLEET_TOKEN` is shared across the fleet,
so it proves *a* node and not *which* node: a compromised node can still claim
to be another and read the apps placed there. The gain is nonetheless real and
this specific — the node's SA loses secret access entirely, so a stolen metadata
token gets nothing; and `fleet-edge-secret`, the control plane's own database
password and every other platform secret leave the reachable set, since none is
named `app-<slug>-<KEY>`. The per-node claim becomes true when the GCE instance
identity token replaces the shared string, which the sync route's header already
describes.

## What this does not decide

The hosting provider (§2, deliberately). Whether to move the shared Cloud SQL
instance (§8). Static apps, which ADR 0001 keeps on Cloud Run permanently and
which nothing here disturbs. Lazy image loading (§4), left open rather than
chosen. The rollout percentage policy that should replace the `FLEET_APPS` list.
