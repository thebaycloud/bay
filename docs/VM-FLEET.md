# Apps run on machines we own

Supersedes nothing. `DEPLOY-PLAN-V2.md` is about the vocabulary the platform
speaks; this is about where the words land. Every conclusion that plan reached
survives, and several of them get easier the moment the runtime is ours.

## The claim

The platform does not need a serverless product. It needs a place to put a
container, a way to reach it, and a disk. Cloud Run gives it the first two on
terms it did not choose and refuses the third, and three-quarters of
`DEPLOY-PLAN-V2.md` is the cost of translating our idea of an app into a product
that has a different one.

The move is **runtime only**:

| Stays exactly as it is | Moves |
|---|---|
| Build → OCI image in Artifact Registry | How that image becomes a running process |
| `supersonic.json`, the Procfile, the four process kinds | Which primitive each kind maps to |
| Cloud SQL, Secret Manager, GCS, Identity Platform | Where the app runs and what it can reach |
| The control plane, the dashboard, the deploy agent | The front door for app traffic |

A build produces an image today and produces the same image after. Nothing in
`build-config.ts`, `dockerfile.ts` or `detect.ts` is in scope. That is what keeps
this diff smaller than it looks.

---

## Verified before writing

Everything below was checked against the tree and against primary sources
(kernel.org, gvisor.dev, GitHub source, Google Cloud docs, the live Cloud Billing
Catalog) rather than recalled. Where nothing authoritative exists, it says so —
those are the parts to measure, not to plan around.

### The three findings that changed the design

**1. Our apps already run on gVisor.** Cloud Run is a gVisor product
(gvisor.dev/users: *"gVisor powers Google Cloud offerings GKE Sandbox, Cloud Run,
App Engine"*), and no `--execution-environment` flag appears anywhere in the
deploy path — `deployArgs` (`lanes.ts:298`) emits `--max-instances`,
`--timeout`, `--concurrency`, `--cpu-boost`, `--memory`, `--cpu` and nothing
else, and the annotation is unset on live services. So choosing `runsc` is not a
new isolation posture that apps must survive. It is the posture they are already
in, operated by us instead of by Google. **The compatibility risk of gVisor is
approximately zero, because it is the status quo.** Every io_uring, `MADV_FREE`,
`userfaultfd` and `perf_event_open` limitation listed below is a constraint our
apps satisfy today or they would not be live.

**2. There is no freezer for a gVisor sandbox, and we do not need one.**

- `runsc pause` exists but does not free memory. Maintainer, on
  google/gvisor#11810: *"in paused state, it continues to occupy memory
  resources. CPU resources are released."*
- Guest-side `cgroup.freeze` is explicitly unsupported (PR 13483, merged
  2026-07-06, lists `cgroup.freeze` under "NOT supported"; issue 13638 is the
  open request; `docker pause` inside a sandbox fails outright, issue 13722).
- Host-side `cgroup.freeze` on a running sandbox is **entirely undocumented**.
  No issue, no PR, no mailing-list thread, no blog post, anywhere. Whether a
  runsc sandbox survives a host freeze/thaw cycle is unknown to the public.
- Checkpoint/restore is the only mechanism that frees a sandbox's memory. It is
  not implemented in the containerd shim and gVisor has no plans to add it
  (#11810, *"No plans for adding support for this yet"*), it drops every open TCP
  connection by design, and issue 13920 (open, 2026-07-30) reports that an
  epoll-registered listener never wakes after restore at ~87% frequency on every
  release from 20241118.0 to 20260721.0 — which breaks tokio, mio, and every
  epoll-based async runtime.

And the reason none of that matters: **an idle gVisor sandbox already costs
almost no CPU.** gvisor.dev/docs/architecture_guide/resources: *"When all
application threads are idle, the Sentry disables timers until an event occurs…
This allows the Sentry to achieve near zero CPU usage for idle applications."*

Cost is not a driver for this move. An idle app that costs no CPU and holds
~200 MB of RAM on a box we are already paying for is not a problem worth an
undocumented mechanism. **Apps stay resident and are never frozen.** Wake latency
is not reduced, it is *deleted* — there is nothing to wake. See section C.

**3. Local SSD survives live migration; it does not survive a stop.** The common
assumption is backwards. Google:

> *"Compute Engine can live migrate instances with Local SSD disks attached…
> Compute Engine moves the compute instances along with their Local SSD data to a
> new host server in advance of any planned maintenance."*

Data is preserved across guest reboot, live migration, and in-place restart on
maintenance. It is lost on a forced stop, on Spot preemption, on a `TERMINATE`
maintenance policy, and on a host error where recovery exceeds
`localSsdRecoveryTimeout`. It can never be snapshotted, never be detached, and
can only be attached at instance creation.

So planned maintenance — the common case, and the thing that would otherwise
require draining hundreds of apps — is handled by Google for free, and the design
only has to survive unplanned host failure. That is a much smaller problem.

### Everything else, with citations

| Fact | Source |
|---|---|
| VPC firewall rules **cannot** block the metadata server. *"Google Cloud always allows communication between a VM instance and its corresponding metadata server at 169.254.169.254."* There is no per-instance off switch; Google's own guidance is *"You must sandbox any process that shouldn't be able to access the metadata server."* | GCP VPC firewalls; metadata overview |
| `c3-standard-16` does not exist. C3 standard shapes are 4, 8, 22, 44, 88, 176. | `gcloud compute machine-types list` |
| us-central1, verified against the live Billing Catalog on 2026-08-03: `n2d-standard-16` (16 vCPU / 64 GiB) $0.6759/hr on-demand, $0.4258 1-yr CUD, $0.3042 3-yr CUD. `n2-standard-16` $0.7769 / $0.4895 / $0.3496. | Cloud Billing Catalog API, service `6F81-5844-456A` |
| Local SSD is 375 GiB per disk. N1/N2/N2D let you **choose** the count (1, 2, 4, 8, 16, 24); C3/C4/C4D only offer fixed `-lssd` machine types. Legacy Local SSD $0.08/GiB-month, $0.036 at 3-yr CUD. | GCP local-ssd docs; Billing Catalog |
| C4/C4A/C4D/C4N Titanium SSD *"might not recover all writes that completed before a power loss event."* | GCP local-ssd data persistence |
| Container-Optimized OS has no package manager, a locked kernel, a read-only root, and a **stateless tmpfs `/etc`**. Installing a containerd runtime handler on standalone COS is undocumented and unsupported. | COS features & security docs |
| gVisor memory overhead vs runc: ~20 MB for an empty container, ~45 MB for a Node app, ~20 MB for a redis holding 1 GB — mostly fixed, plus a term that scales with OS resource usage. (Figures are ptrace-era and stale; treat as an order of magnitude.) | gvisor.dev/performance/density.csv |
| Sandbox application memory is backed by a `memfd`, so cgroup accounting reports it as **shmem, not anon**. Monitoring that reads `anon` under-reports gVisor containers. | gvisor.dev architecture guide |
| The sentry and gofer run **inside the container's own cgroup**, so sandbox overhead counts against the container's memory limit by design. | `runsc/container/container.go:348-350`, `sandbox.go:889-892` |
| `directfs` has been default since 2023-06; the remaining gofer cost is dentry revalidation on shared bind mounts, removable with `--file-access-mounts=exclusive` *"significantly improving performance"* — no figure published, and it corrupts data if the host touches those files. | gvisor.dev filesystem docs |
| **No public benchmark exists** for SQLite, Postgres, or any fsync/mmap-heavy workload under gVisor. None from Google, Modal, Ant Group, or any third party. The closest is a 2020 ptrace-era fio showing random write at 64% of runc. | exhaustive search |
| `msync` is *"PartiallySupported… Full data flush is not guaranteed at this time."* `fsync`, `fdatasync`, `flock`, `fcntl` are fully supported. | `pkg/sentry/syscalls/linux/linux64.go` |
| The kernel's own recommended pattern for many workloads on one host is `memory.high` **deliberately overcommitted**, global pressure arbitrating, and a management agent watching — *"Over-committing on high limit… is a viable strategy."* `memory.high` throttles and never OOMs; `memory.max` is the hard kill. | kernel.org cgroup-v2 usage guidelines |
| `zswap` is cgroup-aware (`memory.zswap.max`, `memory.zswap.writeback`, `memory.stat zswapped`); `zram` is an opaque block device with no memcg integration. For a multi-tenant host that is decisive. Meta reports 20–32% total memory saved fleet-wide with compressed offload and a PSI-driven control loop (Senpai). | kernel.org; engineering.fb.com TMO |
| Certificate Manager issues Google-managed **wildcard** certs via DNS authorization, ACTIVE *"in several minutes."* Legacy Compute Engine managed certs take up to 60 min plus up to 30 more before the LB serves them, and load-balancer-authorized certs do not support wildcards at all. | Certificate Manager docs |
| Cloud Run Direct VPC egress is GA, caps at **1 Gbps per instance**, needs a /26+ subnet, uses 2× IPs per instance, and warns of *"connection establishment delays of a minute or more on instance startup."* | Cloud Run VPC docs |
| Litestream v0.5.15 (2026-07-21) is actively maintained; Fly abandoned LiteFS for it. Async replication, `sync-interval` 1s, **WAL mode only**, exactly one replicator per database, and under write load the app must disable its own autocheckpointing or Litestream falls back to full snapshots. v0.5.0 shipped with restore-corrupting bugs fixed in 0.5.2 — pin and test. | litestream.io; fly.io blog; mtlynch.io |
| SQLite: naively copying a live database *"might contain some old and some new content, and thus be corrupt."* The `-wal` file must be copied **with** the database. The backup API can starve indefinitely on a busy database. `sqlite3_rsync` works live but is peer-to-peer over SSH, not an object-storage path. | sqlite.org howtocorrupt / backup / rsync |
| Prior art on idle: Fly suspends via Firecracker snapshot (≤2 GB machines, few-hundred-ms resume). Koyeb pauses+snapshots with eBPF idle detection, ~200 ms wake, and relies on **TCP retransmission** rather than holding the request. Render, Railway and Cloudflare all just *stop* the container and wipe the disk (Render ~1 min wake; Cloudflare 1–3 s). | vendor docs |

Repo facts the plan hangs on, all current:

- **One argv builder.** Every customer service deploy goes through `deployArgs`
  (`lanes.ts:298`), called from 4 sites in `deploy-pipeline.ts` (2819, 2899,
  2923, 2964) and spawned by `gcloudDeploy` (`deploy-pipeline.ts:298`).
- **The proxy reads exactly two columns**: `apps.run_url` and `apps.routes`
  (`services/proxy/src/index.ts:69`, `registry.ts:11,17`). `run_url` also doubles
  as the "has this app ever built" signal (`index.ts:49`).
- **`SEAL_APPS`** (`deploy-pipeline.ts:68`) switches six behaviours at once: the
  auth flag on both deploy paths (`:2240`, `:2790`), `grantInvokers` on both
  (`:2451`, `:2832`), the probe's sealed mode, whether a domain mapping is created
  (`:3284`), the "Live at" log line (`:3193`), and the URL returned (`:3307`).
  **Off by default — so today every customer service is world-invokable at its
  `*.run.app` URL and the proxy's visibility checks are bypassable by going
  direct.**
- **`APP_RUNTIME_SERVICE_ACCOUNT` is unset** (`CUTOVER.md:385`), so hosted apps
  inherit the default compute account and its project-wide admin roles.
- The Cloud SQL sidecar is attached at **four** emission points (`lanes.ts:352`,
  `release-job.ts:288`, `process-deploy.ts:249`, `process-deploy.ts:201`), three
  of which need a startup probe and one of which cannot have one, so ordering is
  done by a shell wait loop (`proxyWait`, `release-job.ts:202`).
- **Two cron implementations coexist**: the process path
  (`process-deploy.ts:285` → Cloud Run Admin API `:run` with OAuth) and the
  legacy Scheduler HTTP ping at the app's own URL (`gcloud.ts:295`, no auth flag),
  which the code itself notes will 403 the day `SEAL_APPS` flips.
- **`deleteApp`** (`gcloud.ts:434`) tears down 12 things and touches **none** of
  the worker pools, process jobs, Scheduler entries, release job, or
  `ss-exec-<slug>` job.
- **Three declared fields never reach the cloud**: `visibility` (the emitter
  `webIngressFlags`, `process-deploy.ts:337`, has no non-test caller),
  `shutdownGrace` (documented unemittable, `processes.ts:197`), and a Procfile
  `release:` line (`deploy-pipeline.ts:469`).
- **`deploys` and `deploy_runs` exist only as lazy `CREATE TABLE IF NOT EXISTS`**
  in `deploys.ts:12` and `deploy-runs.ts:35`. `apps/web/db/*.sql` is not a
  complete schema.
- Nothing anywhere gives an app a writable persistent disk: no `--add-volume`,
  no gcsfuse, no tmpfs, no Filestore in the deploy path.

---

## A. The host

**`n2d-standard-16` on Ubuntu LTS, with Local SSD, `MIGRATE` on host maintenance,
`automaticRestart` on.** Not Spot — Spot cannot live migrate, cannot auto-restart
after host error, and loses Local SSD on preemption, which trades away all three
things this design leans on to save money we are not trying to save.

- **N2D over N2** on price ($0.6759 vs $0.7769/hr) and over C4/C4D on two counts:
  N-series lets you choose the Local SSD count instead of forcing an `-lssd`
  machine type, and C4-family Titanium SSD carries the acknowledged-write-loss
  warning. For a stateful fleet that warning is disqualifying.
- **Not COS.** No package manager, locked kernel, read-only root, and an `/etc`
  that is stateless tmpfs — a containerd runtime handler would have to be
  re-installed by cloud-init on every boot with no support behind it. Ubuntu LTS
  with a baked image is the lower-risk base.
- **Sizing is not a packing exercise.** Cost is not a driver, so run at ~50%
  memory utilization and add nodes early; headroom is what lets one node absorb
  another's apps. Order-of-magnitude arithmetic, to be replaced with a
  measurement: a Node app at ~120 MB plus ~45 MB of sandbox is ~165 MB resident,
  so ~55 GiB of usable RAM is a few hundred apps per node. Do not promise a
  number before section "Measure first" has run.

## B. Isolation

**containerd with `runtime_type = "io.containerd.runsc.v1"`**, systrap platform,
directfs on, netstack (not `--network=host`).

This is the same sandbox the apps run in today, so the question is not "will apps
survive it" but "what do we now own that Google owned." Three things:

- **The July 2026 release layout change.** gVisor moved from two binaries to a
  tarball with a `gvisor-bin/` directory that must travel next to `runsc`. The
  auto-download fallback that papers over a partial install **is removed at the
  end of September 2026**. Any install automation that copies only the `runsc`
  binary breaks. Bake the whole tarball into the node image.
- **Sandbox overhead is charged to the tenant.** The sentry and gofer live in the
  container's cgroup by design, so a 512 MiB `memory.max` is ~467 MiB of app.
  Size the floor accordingly rather than discovering it as an OOM.
- **Container memory reads as shmem.** Any node metric that sums `anon` will
  under-report every app on the box.

Deliberately **not** Firecracker: it needs nested virtualization, which is a
narrower and slower path on GCE, and it would be a stronger boundary than the one
these apps run behind today — a change of posture bought at real cost for no
change in threat model.

## C. Idle, and why there is no freezer

**Apps are started once and stay resident until they are redeployed or the app is
deleted. Nothing is frozen, paused, snapshotted, or stopped for idleness.**

This inverts the mechanism this plan started with, and finding 2 above is why:
every freeze mechanism that exists for gVisor either does not free memory
(`runsc pause`), does not exist (guest `cgroup.freeze`), is undocumented on a
sandbox (host `cgroup.freeze`), or is unshipped and carries an open 87%-frequency
listener-loss bug (checkpoint/restore). Meanwhile the sentry parks its own timers
when the app is idle, so the thing freezing would have saved — CPU — is already
near zero.

What we get by not doing it:

- **No wake path.** No request to hold, no thaw to time out, no first-packet drop
  and TCP-retransmit trick (Koyeb's published mechanism), no 502-on-first-request
  (Railway's). The app is running; the router forwards.
- **Websockets, SSE and long polls just work.** A frozen process cannot answer a
  ping, so every heartbeat budget in the stack (25–60 s is typical) tears the
  connection down. Resident apps have no such window.
- **In-process timers keep running.** An app doing `setInterval` inside its web
  process keeps its semantics. Under a freeze it would have silently stopped.
- **Clocks stay honest.** gVisor's sentry recalibrates against the host TSC and
  logs *"time may jump"* on extreme error; a multi-minute freeze would put a
  discontinuity into every guest's `CLOCK_MONOTONIC`.

What replaces it, when memory pressure eventually arrives — and only then:

1. **`memory.high` per app, deliberately overcommitted**, exactly as the kernel
   documentation recommends. `memory.max` as a hard ceiling well above it, so the
   throttle is the normal control and OOM is the exception.
2. **zswap, not zram** — cgroup-aware, so a tenant's compressed footprint is
   accountable and cappable, and it degrades to real swap instead of hitting a
   wall. Meta's 20–32% fleet-wide saving is the evidence this is worth doing at
   all.
3. **A PSI-driven reclaim loop** (Senpai's shape): watch `memory.pressure`, call
   `memory.reclaim` on the coldest apps, back off when pressure rises. This is a
   Phase 2 item. It is not needed to ship.

Freeze/thaw stays in the drawer as a possible optimization behind an experiment
(section "Measure first", item 3), not as an architecture.

## D. State

**Local SSD, one directory per app, with continuous replication to GCS. The node
is not the durable copy.**

- `/srv/apps/<slug>/data` on the Local SSD array, bind-mounted into the sandbox.
  Quota per app; `io.max` per app so one tenant's `dd` cannot stall the box.
- **`--file-access-mounts=exclusive` on the data mount** removes the dentry
  revalidation that is the remaining gofer cost with directfs. It is safe here
  precisely because nothing on the host touches an app's data directory — which
  must then be true, and enforced, not just intended.
- **SQLite gets Litestream**, one replicator process per database, pinned to a
  tested version. The contract to state plainly in the docs: WAL mode only,
  ~1 second of asynchronous lag, not zero-loss. Under sustained writes the app
  must set `PRAGMA wal_autocheckpoint = 0` or Litestream degrades to full
  snapshots.
- **Everything else gets periodic snapshots** — and this is the honest gap:
  there is no off-the-shelf sub-minute *crash-consistent* backup for an arbitrary
  directory on Linux. restic's only live-file consistency mechanism is
  Windows-only VSS; rclone `sync` is a mirror with no history; Storage Transfer
  Service bottoms out at one hour. The real answer is a filesystem-level snapshot
  (LVM or btrfs) shipped to GCS, and it should be built that way from the start
  rather than discovered after the first restore.
- **Never hand-roll a SQLite copy.** The `-wal` file travels with the database or
  the backup is corrupt; the backup API starves on a busy database; `VACUUM INTO`
  and `sqlite3_rsync` are the safe reads.
- Cloud SQL and GCS stay exactly as they are. A managed Postgres is still the
  right default; the disk is for the apps a managed Postgres cannot serve.

**Recovery, stated as a promise:** planned maintenance is invisible (live
migration carries the data). Unplanned host loss means the app is rescheduled on
another node and restored from its replica — seconds of data loss for SQLite,
one snapshot interval for everything else, and minutes of downtime. That is the
promise; it goes in the product copy, not just the runbook.

## E. The front door

**A global external Application Load Balancer with a Certificate Manager wildcard
cert for `*.supersonic.cv`, in front of the fleet. The router runs on every node.
Cloud Run leaves the app data path entirely.**

- Direct VPC egress from the existing Cloud Run proxy was the smaller change and
  is the wrong one: 1 Gbps per instance, and *"connection establishment delays of
  a minute or more on instance startup"* on a service that fronts every app.
- `services/proxy` is ~1,100 lines of standalone Node with its own Dockerfile. It
  runs on a node unchanged except for where it gets its data.
- **The routing table is replicated to every node**, not queried per request. It
  is one row per app; the host agent keeps a local snapshot. This is what makes
  the data plane survive a control-plane outage — today's 30-second DB cache does
  not.
- Nodes get `AUTH_SECRET` for session-cookie verification and call the control
  plane over HTTP for the access decision on non-public apps (short-cached).
  **Nodes never hold Postgres credentials**, which the proxy does today
  (`registry.ts:54`).
- `x-serverless-authorization` and `idtoken.ts` are deleted — there is no Cloud
  Run invoker to authenticate to. Node-to-app is a loopback hop.
- **Certificate provisioning stops being a 15-minute wait per app.** One wildcard
  cert, ACTIVE in minutes, and `createDomainMapping` and its three siblings go
  away. Custom domains (Phase 8) become a Certificate Manager map entry instead
  of a per-app Cloud Run domain mapping.

## F. The process model collapses

This is the section that pays for the move. On a node there is one primitive —
run this argv in this sandbox — and the four kinds are scheduling policy on top
of it:

| Kind | Cloud Run today | On a node |
|---|---|---|
| `web` | `run deploy` + ingress + probes + invoker IAM + domain mapping | long-lived, port assigned by us, registered in the routing table |
| `worker` | `beta run worker-pools deploy`, fixed `--scaling N`, no port, no probes, no `--depends-on` | long-lived, no port |
| `cron` | `run jobs deploy` **plus** a Scheduler entry with an OAuth SA hitting the Admin API `:run` endpoint — two resources, deleted in a specific order or the schedule fires forever at a target that is gone | a timer that runs the argv |
| `release` | its own Cloud Run Job, its own deploy/execute/logs argv trio (`release-job.ts`) | run the argv, wait for exit |

Three declared-but-unemitted fields start working for free, and their absence was
never a design decision — it was a flag that did not exist:

- **`shutdownGrace`** — SIGTERM, wait, SIGKILL. No YAML replace path needed,
  which was the entire argument for ordering step 4 of `DEPLOY-PLAN-V2` where it
  is.
- **`visibility: internal`** — do not register it in the routing table.
- **A Procfile `release:` line** — it is the same mechanism as every other kind.

And the Cloud SQL sidecar becomes **one `cloud-sql-proxy` per host** instead of
four emission points, three startup probes, and a shell wait loop. `proxyWait`,
`dbContainerArgs`, `dbProxyContainer`, `DB_HEALTH_PORT` and the sixty lines of
comment explaining why the probe cannot be TCP all go.

## G. What the fleet must honour

The contract is not up for renegotiation in this change. An app that works today
works after, or the cutover is a regression wearing an architecture diagram.

- **Injected env, in full**: `PORT`; the 17 database names from `databaseEnv`
  (`lanes.ts:75`), with `DATABASE_URL` and any `*PASSWORD` delivered as secrets
  (`env-merge.ts:33`); `SUPERSONIC_URL`, `SUPERSONIC_HOSTNAME`,
  `SUPERSONIC_SCHEME`, `SUPERSONIC_PATH_PREFIX` (`framework-env.ts:34`);
  `frameworkEnv`'s Django/Rails/Next/FastAPI proxy-awareness (`:52-98`);
  `SUPERSONIC_REPO`, `STORAGE_BUCKET`, `GOOGLE_CLOUD_PROJECT` when applicable.
  The 17 names stay until `DEPLOY-PLAN-V2` section D deletes them, on its own
  schedule, not this one's.
- **Health** is `{path, expect}` verified *after* the process is live — 4
  attempts, 20 s each, `min(2000×n, 8000)` backoff, strict only when the author
  declared it (`verify-app.ts:86`, `deploy-pipeline.ts:2301`). The fleet keeps
  that exact verdict logic including the `REFUSED` body regex, because a
  behaviour change there reads to a user as "my app broke."
- **`--update-env-vars` semantics are load-bearing.** Env merges on the service
  path so a redeploy cannot drop a value someone set with `supersonic env set`;
  worker and cron are desired-state. Preserve both, per kind.
- **Path-prefix routing** (`routes.ts`) is unchanged: longest prefix wins, match
  only at a path boundary, `x-forwarded-prefix` set for the mounted service.
- **Static apps do not get a sandbox.** One shared server reads
  `<slug>/r/<release>/` from GCS with a `<slug>/current` pointer. That works; it
  moves onto the fleet as an ordinary resident process and nothing else changes.
- **Secrets stay in Secret Manager**, one per variable, `app-<slug>-<KEY>`. The
  host agent resolves them at start; they are never written to node disk.
- **`execCommand`** stops deploying an `ss-exec-<slug>` Cloud Run Job and becomes
  an exec into the running sandbox — which is also what makes the resident agent
  worth having.

## H. Security

This section is the one that can end the project, and two items in it are
strictly better than what we have today.

- **Apps get no GCP identity.** Today `APP_RUNTIME_SERVICE_ACCOUNT` is unset and
  every hosted app inherits the default compute account with project-wide admin
  (`CUTOVER.md:385`) — the deferred, higher-risk change. On a node the fix is
  free: the app has no metadata server to ask.
- **Block 169.254.169.254 in the guest, because nothing else can.** VPC firewall
  rules do not apply to metadata traffic — Google always allows it — and there is
  no per-instance switch. gVisor is what makes this enforceable: with netstack,
  all non-loopback traffic leaves the sandbox through a single host-side
  interface, so host nftables on that interface is a real boundary. Get this
  wrong and any app curls the node's SA token and owns the project.
- **`SEAL_APPS` becomes moot, and that is a fix.** Today the flag is off, so
  every app is world-invokable at its `*.run.app` URL and the proxy's visibility
  model is bypassable. On a node the app listens on loopback and the router is
  the only way in — the sealed model by construction rather than by flag.
- Per-app cgroup limits: `memory.high` / `memory.max`, `cpu.weight` (shares, not
  quotas, so a bursting app can use an idle box), `pids.max`, `io.max`, and
  egress shaping. Note that gVisor does **not** enforce limits set *inside* the
  sandbox; enforcement is host cgroups only.
- Note for later, not now: `deleteApp` already leaks worker pools, process jobs,
  Scheduler entries and release jobs. On a fleet, deleting an app is removing
  rows and stopping containers, so the leak stops existing rather than getting
  fixed.

---

## What this deletes

`deployArgs` and its 4 call sites · `scaleServiceFlags` / `scaleContainerFlags` ·
`createDomainMapping` / `removeDomainMapping` and the two other domain-mapping
call sites · `grantInvokers`, `PROXY_SA`, `callerMember` · `clearStaleCloudSql` ·
`dbProxyContainer` / `dbContainerArgs` / `proxyWait` / `DB_HEALTH_PORT` ·
`workerPoolArgs` / `cronJobArgs` / `cronScheduleArgs` / `cronScheduleUpdateArgs`
and the orphan-deletion argv shapes · `release-job.ts`'s deploy/execute/logs trio
· the legacy Scheduler cron in `gcloud.ts:293` · `x-serverless-authorization` and
`idtoken.ts` · `existingScoped` / `liveContainerShape` · `rollback` via
`update-traffic` · `gcloud logging read resource.type=cloud_run_revision` in four
places · `SEAL_APPS` and its six branches.

Roughly 2,000–2,500 lines across the files listed in the fact table, most of it
in `deploy-pipeline.ts` (3,374 today), `lanes.ts` (354), `process-deploy.ts`
(352), `release-job.ts` (327) and `process-plan.ts` (237).

## What gets harder

- **On-call.** Google currently handles node repair, capacity and zonal failover.
  Live migration covers planned maintenance; unplanned host loss is ours.
- **Scaling one app past one node.** `maxInstances: 10` was free. It stops being
  free, and for the small-software workload it stops being needed — but the day
  one app needs it, we build it.
- **Node image lifecycle.** Kernel updates, the gVisor tarball, containerd
  versions, and a drain procedure that must exist before it is needed.
- **A stateful app pins its node.** Local SSD cannot be detached. Rescheduling a
  stateful app is a restore, not a move.
- **Capacity planning becomes a thing we do.** Not hard at this size; new.

## Order

| # | Work | Days | Status |
|---|---|---|---|
| 0 | **Measure first.** Nothing else starts until density and serving have numbers. | 3 | **done** — see Measured |
| 1 | Node image: Ubuntu LTS + containerd + runsc (whole tarball) + host `cloud-sql-proxy` + nftables metadata block | 3 | **done** — `image/provision.sh`, idempotent |
| 2 | `supersonicd`: reconcile loop, secret resolution, health, drain. Go static binary; pull-based with an on-disk cache | 8 | **done** for `web`; log shipping and exec outstanding |
| 3 | Placement in the control plane: a table, a function, and `apps.runtime` | 2 | **done** — `013_fleet.sql`, `lib/fleet.ts`, `/api/fleet/sync` |
| 4 | Router on the node + replicated routing table, minus the ID-token path | 4 | **partly** — node-local works; fleet-wide forwarding and the auth/visibility half of `services/proxy` are not moved |
| 5 | GCLB + Certificate Manager wildcard | 2 | **partly** — LB serves on `8.232.255.172`; the wildcard cert is blocked on DNS |
| 6 | Emit the four process kinds against the agent instead of gcloud; `shutdownGrace`, `visibility` and Procfile `release:` start working | 5 | **done** in the agent — web, worker, cron and release all run; the deploy pipeline does not emit them yet |
| 7 | Volumes: quota, mounts, `exclusive` file access, Litestream, filesystem snapshots to GCS | 5 | not started |
| 8 | Static apps onto the fleet; delete the Cloud Run path | 2 | not started |
| 9 | Cutover: dual-run, wave the fleet, delete the Cloud Run emitters | 4 | **19 apps cut over and serving from the fleet.** Cloud Run emitters still in place — dual-run, as designed |
| 10 | Memory pressure: `memory.high` overcommit, zswap, PSI reclaim loop | 3 | not needed yet — zero swap in use at 100 apps |

Steps 7 and 10 can slip. Step 0 cannot, and steps 1–2 are what turn this from a
document into a fleet.

### The cutover, as it actually went

19 of 47 live apps now serve from the fleet. All 19 answer through
`https://<slug>.supersonic.cv` — the real path, through the real proxy, with the
proxy's own sign-in gate still enforcing visibility in front of the private ones.
20 sandboxes on one node, 20/20 healthy, 3.1 GB of 64 GB used.

The edge proxy was not modified. It already forwards `x-supersonic-slug` — that
is how the shared static server has always known its tenant — so pointing
`apps.run_url` at the fleet load balancer was the entire change per app.

`services/fleet/migrate.sh` does place → verify → flip, in that order, and only
that order is safe: an app that does not answer from the fleet is rolled back to
Cloud Run before anything routes to it. Several were, and they are still on Cloud
Run, unharmed.

The remaining 28 are not blocked on the fleet. 19 have no image at all (static or
runner lane) and 9 failed verification because they need env or a database they
were not given.

### What "they need env or a database" turned out to mean — 2026-08-04

Two different problems wearing one sentence, and only the first was the one we
thought we had.

**The spec could not say it.** `lib/fleet.ts` declared `AppSpec` with a comment
promising it was the agent's `App` verbatim. It was not: the agent had `secrets`
— env var name to Secret Manager id, resolved on the node by its own service
account so values never touch node disk — and `processes`, all four kinds. The
control plane's copy had neither. Not a missing feature at either end; a missing
field in the middle, held together by a comment. Fixed: one declaration in
`lib/fleet-spec.ts`, and a test that reads `type App struct` out of `main.go` and
compares the key sets, so the next field the agent grows fails a test instead of
silently not arriving.

**And carrying it is not sufficient.** `provisionPostgres` writes

```
DATABASE_URL = postgresql://user:pass@127.0.0.1:5432/db
```

which resolves only because a Cloud SQL Auth Proxy **sidecar** runs beside the
app in the same Cloud Run service (`dbContainerArgs`). A node runs one sandbox
per process and has no sidecar, so the identical url points at a port with
nothing behind it.

Measured while picking a first canary: of the 23 apps that have any secret at
all, **not one is on the fleet** — the 19 that moved are precisely the apps with
nothing to carry. And every app whose secrets are not a database is on the runner
lane, so today no eligible app exercises `secrets` at all.

The failure shape is why this is a refusal rather than a note. A database-backed
app placed on a node **starts**, serves its homepage, answers the probe with 200
— place, verify and flip all pass — and then fails every request that touches
data. A placement that passes its own check and breaks the app is strictly worse
than one that never happens. So `fleetEligibility` refuses it by name, in the
deploy log.

**A per-app Cloud SQL proxy process on the node** is what unblocks the 9. The
agent already has the primitive — a process is a process — and the node already
holds `cloudsql.client`. What it needs is a proxy process sharing the app's
network namespace so `127.0.0.1:5432` means the same thing it means on Cloud Run.
That is a piece of work, not a flag, and it is the next thing worth doing here.

### Placement moved into the deploy pipeline — 2026-08-04

`chooseNode` had no callers; placement was `migrate.sh` run by hand. It is now
`lib/fleet-place.ts`, called at the end of a deploy: place → verify → flip, the
same order and the same reason, with every external thing behind a port so the
two paths that must not be wrong are testable without a node.

- **A full fleet** (`chooseNode` → `null`) was unhandled anywhere in the repo.
  The app stays on Cloud Run, where it already is.
- **Rollback** sets `runtime='cloudrun'`, which drops the placement, and the node
  stops running it on its next reconcile without being told.

Behind `FLEET_APPS=<slug>` for one app at a time — the shape `BUILDKIT_APPS`
already uses — or `FLEET_PLACEMENT=1` for all, and skipped entirely when
`FLEET_LB` is unset. Four refusals, each named in the log: static, runner, no
image, worker-only (no route to verify through), and a database.

### What is blocked on someone else

- **HTTPS.** A Google-managed wildcard for `*.supersonic.cv` needs a DNS
  authorization TXT record, and the zone is at Namecheap rather than Cloud DNS.
  Until that record exists the load balancer is HTTP only.
- **The DNS cutover itself.** `*.supersonic.cv` resolves to `8.233.7.157` today.
  Pointing it at `8.232.255.172` is the switch, and it is one record.
- **Runner-lane apps cannot be placed at all.** They fetch a code bundle from GCS
  at container start using a metadata token the sandbox is now correctly denied.
  Each needs a real image before it can move — this is wave-planning work for
  step 9, and it decides how large the first wave can be.

## Measured — 2026-08-03, `fleet-lab-1`, n2d-standard-16

Run on a real node against real customer images from
`cloud-run-source-deploy`. `services/fleet/bench/` holds the scripts.

| Question | Answer |
|---|---|
| Does a customer image run under gVisor on our own node? | Yes. HTTP 200, 796 bytes, **TTFB 1.6 ms**, `uname -r` → `4.19.0-gvisor`. |
| Start to serving | **0.2 s** on a warm image; a cold pull dominates everything else. |
| Resident cost per app (`memory.current`) | **64–69 MB mean**, stable from 25 apps to 100 (85 measured, 5,519 MB total). |
| Implied ceiling on 55 GiB usable | ~850 apps by memory alone. CPU and working set will bind first — but the plan's "a few hundred per node" is not optimistic, it is conservative. |
| Can a sandbox read the node's SA token? | **No.** Blocked, while DNS to the same address still works. |
| Is compression in play yet? | No. Zero swap used at 100 apps. `memory.high` and zswap are not needed at this density. |

The number that replaces the placeholder is **~64 MB per resident app**. Note it
is `memory.current`, not RSS: summing RSS across `runsc-*` processes reports
~435 MB for a single app because the sentry's `memfd` is counted repeatedly.
Anything measuring this fleet by RSS will be wrong by roughly 7×.

Two things this run also settled:

- **Serial reconcile does not survive a real node.** Each start includes an image
  pull, so bringing up 25 apps took minutes — and because routes were published
  only at the end of a pass, the routing table stayed empty the whole time while
  the apps were up and listening. Starts are now concurrent (bounded at 8) and
  each app is published the moment it serves. A node rebooting with 200 placed
  apps would otherwise have been dark for as long as it took to walk the list.
- **Runner-lane images cannot move as-is.** They fail with `python: can't open
  file '/app/app.py'` because that base image expects to fetch and unpack a code
  bundle from GCS at container start, using a metadata-server token the sandbox
  is now correctly denied. Those apps need a real image before they can be
  placed. This is a migration prerequisite, not a fleet defect, and it belongs in
  the cutover wave planning in step 9.

## What the process model cost, in the end

One primitive and four policies, as promised — and one trap that is worth
writing down because nothing warns you about it:

**runsc resolves container ids by PREFIX.** Naming the web process `a8ebb` while
its worker is `a8ebb--ticker` makes `runsc state a8ebb` fail with *"id is
ambiguous and could refer to multiple containers"*, and `runsc delete --force
a8ebb` fail the same way **while exiting 0**. The agent concludes the start
failed, leaves a live sandbox behind, and every later attempt collides with it
forever. The observable symptom is an app that is running and unreachable, and a
log that says `container already exists` about a container nothing can address.

So no sandbox id may be a strict prefix of another. Every kind is suffixed —
including `web` — and ids end in a dot, because process names are
`[A-Za-z0-9_-]+` and so can never contain one: `a8ebb--web.` cannot be a prefix
of `a8ebb--webhook.`.

Two smaller ones from the same session: `release` must be keyed on the IMAGE it
ran for, or it re-runs on every reconcile pass that finds any process not yet up
— running a customer's migration repeatedly, concurrently with itself. And each
process needs its own log file; sharing one interleaves a web server's request
log with a worker's output and a migration's, which is the first thing anyone
reads.

## Still to measure

Three numbers decide whether the rest of the shape is right. None of them is
published anywhere, and two of them nobody has published for anyone.

1. **SQLite in WAL mode under runsc on Local SSD, versus runc, versus Cloud SQL.**
   Persistent disk is a stated driver and gVisor has no published database
   benchmark of any kind. If the number is bad the fork is: accept it, drop
   `--file-access-mounts=exclusive` in favour of something stronger, or run
   stateful apps on a less-sandboxed node pool. Also confirm `mmap` on the `-shm`
   file works — the source path returns `ENODEV` without a host FD, and nobody
   has run it.
2. **Steady-state CPU at density.** Memory is settled; CPU is not. The 100-app
   bring-up drove load average past 30, which is startup cost — eight concurrent
   pulls and sandbox boots — and says nothing about a node holding 300 idle
   sandboxes. The claim that matters is gVisor's "near zero CPU usage for idle
   applications", and it should be measured on a quiet node, not inferred from a
   noisy one.
3. **Freeze is now firmly optional.** At 64 MB per app with zero swap in use at
   100 apps, nothing is asking for it. If it is ever revisited: does a host
   `cgroup.freeze` on a runsc sandbox thaw cleanly, does the guest clock jump, do
   TCP connections survive. Unexplored publicly, and now clearly an experiment
   rather than a dependency.

## The one real risk

**Everything moves at once.** `MAKE-DEPLOYS-WORK.md` already logged this exact
failure mode for a smaller change, and the answer is the same one: the decision
is big-bang, the mechanism is not. `apps.runtime` (`'cloudrun' | 'fleet'`) is one
column, the router reads placement per app, and a single bad app goes back with
one row update. Wave the fleet — our own apps, then apps with no database, then
the rest — and keep the Cloud Run emitters until the last wave has been live for
a week.

The second risk is quieter: **`apps/web/db/*.sql` is not a complete schema.**
`deploys` and `deploy_runs` exist only as lazy `CREATE TABLE IF NOT EXISTS` in
application code. Anything that provisions a database from the migrations — a
staging fleet, a DR rehearsal — comes up missing the two most load-bearing tables
on the deploy path. Fix that before it is discovered during a restore.
