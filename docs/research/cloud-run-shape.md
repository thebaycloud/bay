# How Cloud-Run-shaped is the deploy path, now that the fleet is real?

Research date: 2026-08-06. Read-only investigation against the tree at
`/Users/ilmak/projects/supersonic`. `docs/DEPLOY-PLAN-V2.md` (619 lines) and
`docs/VM-FLEET.md` (639 lines) were read in full first; all line-number
citations below are re-verified against the current tree, not copied from
those docs — `deploy-pipeline.ts` alone has grown from 3,374 lines (when
VM-FLEET.md was written) to **4,253 lines** today, so most citations shifted.

Files sized for scale: `deploy-pipeline.ts` 4,253 ln, `gcloud.ts` 800 ln,
`lanes.ts` 435 ln, `fleet.ts` 588 ln, `fleet-place.ts` 659 ln, `fleet-spec.ts`
277 ln, `fleet-status.ts` 640 ln, `process-deploy.ts` 407 ln, `release-job.ts`
327 ln, `services/fleet/agent/main.go` 1,595 ln.

---

## The one-paragraph answer

The deploy pipeline is still built as a Cloud Run pipeline with one fork
bolted in, not a target-neutral pipeline with two adapters. There is no
"deploy target" interface: the entire dispatch mechanism is a single boolean,
`toFleet` (`apps/web/lib/deploy-pipeline.ts:2231`), computed once and then
re-read ad hoc at roughly **16 sites** across a 4,253-line file, plus **5 more
independent re-derivations** of the same fact (`runtimeOf(slug) === "fleet"`)
scattered across API routes that share no code with the pipeline. Of the
pipeline's 14 named stages, 6 are genuinely shared, 3 branch internally, and 5
exist for one target only. The ugliest seams are not the named stages but two
~350-line, Cloud-Run-shaped functions (`deploySibling`, `fetchContainerError`)
with fleet behavior bolted into the middle or end. Two live bugs were found
that neither design doc mentions: fleet apps still trigger a doomed
`createDomainMapping` call, and the pipeline's own automatic rollback-on-
failure safety net silently no-ops for fleet apps. `docs/VM-FLEET.md` itself
is stale on one point: `services/fleet/README.md:238` still says "a deploy
still goes to Cloud Run; `fleetctl` places an already-built image by hand" —
untrue since the pipeline started calling `chooseNode`/`placeApp` directly.

---

## 1. Where Cloud Run is assumed rather than chosen

### 1a. Genuine adapters — Cloud Run called, but the coupling is contained

A handful of places were built (or already were) runtime-aware and hold up
well:

- **`apps.run_url`** (`apps/web/db/001_sharing.sql:20`) is a plain `text`
  column with no Cloud-Run-specific shape and **no `revision` column anywhere
  in the schema**. `markAppLive` writes either the Cloud Run URL or the fleet
  load-balancer address into the same field
  (`deploy-pipeline.ts:4152`/`4167`). Genuinely neutral.
- **`services/proxy/src/upstream.ts:34-41`** (`isCloudRunTarget`) picks by
  hostname suffix (`*.run.app`) whether to mint a Cloud Run ID token or send
  the fleet's `x-supersonic-edge` header — a real, working seam.
- **`apps/web/lib/log-filter.ts:25-30`** (`appLogFilter`) already ORs
  `resource.type=cloud_run_revision` with `resource.type=gce_instance`,
  explicitly because an app mid-migration has log lines in both places.
- **`apps/web/lib/db-address.ts`** (`CLOUD_RUN_DB` = 127.0.0.1 sidecar vs
  `FLEET_DB` = 10.200.0.1 bridge gateway) is a clean, small seam threaded
  through `deploy-pipeline.ts:2238`.
- Four API routes check `runtimeOf(slug)` and answer honestly for fleet apps:
  `app/api/apps/[slug]/route.ts:37`, `env/route.ts:26,47`, `exec/route.ts:24`
  (explicit `501` with a reason), `rollback/route.ts:21` (explicit `501`
  stating *"a placement holds one spec, not a history, so the previous
  version is not written down anywhere"*).

### 1b. Real coupling — Cloud Run assumed to exist

- **`deployArgs`** (`apps/web/lib/lanes.ts:379-435`) is Cloud Run's own argv
  grammar verbatim: container-naming immutability rules
  (`needsServiceRecreate`, `lanes.ts:375`), `--port` (`:416`),
  `scaleServiceFlags` (`--max-instances`, `--timeout`, `--concurrency`,
  `--cpu-boost`, `lanes.ts:261-268`). **4 call sites**, confirmed still
  exactly 4 as the file grew: `deploy-pipeline.ts:3207, 3455, 3465, 3484`
  (were 2819/2899/2923/2964 in VM-FLEET.md — same count, shifted lines).
  `Scale` (`lanes.ts:215-224`) is a Cloud-Run-shaped type by construction —
  matches DEPLOY-PLAN-V2's own finding that `Scale` is "a web-shaped type."
- **Cloud SQL sidecar — still exactly 4 emission points**, re-verified:
  `lanes.ts:433` (scoped service, with `--depends-on`), `process-deploy.ts:201`
  (worker pool, no `--depends-on` possible — no probe flag exists on that
  primitive), `process-deploy.ts:249` (cron job, with `--depends-on`),
  `release-job.ts:288` (release job). Same count VM-FLEET.md logged; ordering
  is still done by a shell wait loop (`proxyWait`) because one of the four
  can't have a startup probe.
- **`SEAL_APPS`** (`deploy-pipeline.ts:82`, was `:68`) still switches exactly
  6 behaviors, all reachable only from the Cloud Run closure except two that
  live in the shared tail (see §3, domain-mapping gap): auth flag
  (`:2459, 3133`), `grantInvokers` (`:2699, 3220`), probe mode (`:2701, 3233`),
  the "Live at" log line (`:3991`), the domain-mapping branch (`:4108`), the
  URL shape returned to the client (`:4186`).
- **`gcloud.ts`** is ~15 exported functions built entirely around
  `gcloud run …` / `gcloud beta run …` / Cloud Scheduler / Cloud Logging with
  `resource.type=cloud_run_revision`. None of `deleteApp`
  (`gcloud.ts:530-691`, ~15 teardown steps — grown past VM-FLEET.md's count of
  12), `rollback` (`:430-437`), `listWorkers` (`:133-144`), or `execCommand`
  carry any fleet awareness.
- **`process-deploy.ts`** — `workerPoolArgs`, `cronJobArgs`,
  `cronScheduleArgs`/`cronScheduleUpdateArgs`, `appPingScheduleArgs` are 100%
  Cloud Run/Scheduler primitives. Correctly neutralized at the call site for
  fleet apps (§2), but three **read-side** routes were not updated to match:
  `workers/route.ts:28` calls `listWorkers` unconditionally and silently
  returns `[]` for fleet apps (wrong, not refused); `jobs/route.ts` POST calls
  `describeService(slug)` for a fleet app and throws, caught only by a generic
  handler; `fix/route.ts:32` and `diagnose/route.ts:58` call `describeService`
  with no `runtimeOf` guard, so the repair-agent dashboard features are
  non-functional (not just narrower) for fleet apps.
- **`verify-app.ts:106`** — a Cloud-Run-specific message ("check the
  run.invoker binding") is shown for a fleet app's 403s too, which have a
  different real cause (edge-secret mismatch / router rejection).

### Rough tally

Grep hits for Cloud-Run vocabulary (`run.app`, `gcloud run`, `revision`,
`traffic`, `cloud_run_revision`, `run_url`, `--port`, `invoker`,
`domain-mapping`) per file: `deploy-pipeline.ts` 62, `gcloud.ts` 27,
`process-deploy.ts` 14, `release-job.ts` 13, `lanes.ts` 10, `fleet-place.ts` 8,
`app-config.ts` 5, `fleet.ts` 5. **14 of 20** route files under
`app/api/apps/[slug]/**` reference Cloud Run vocabulary directly; only **4**
of those fork cleanly on `runtimeOf`; **4 more** (`workers`, `jobs`, `fix`,
`diagnose`) reference it with no fork and are wrong or broken for fleet apps
today rather than merely unmigrated. Schema-wise: exactly one
runtime-touching column (`run_url`), and it is neutral by design; no
`revision` column exists anywhere.

---

## 2. What the fleet path had to work around

Quantified: `toFleet` is branched on at **~16 sites** in
`deploy-pipeline.ts` (`:2231, 2238, 3109, 3722, 3723, 3731, 3751, 3753, 3918,
3937, 4004, 4085, 4143`, plus `placeOnNode`-gated forks at `:3109, 3176`), fed
by one decision at `:2230-2231`. Outside the pipeline, `runtimeOf(slug) ===
"fleet"` is independently re-checked in 5 more places (4 routes + the sync
endpoint).

Concrete compensations found:

1. **`db-address.ts` exists only because Cloud Run's Cloud SQL sidecar
   answers on loopback and a gVisor sandbox's loopback never leaves the
   sandbox.** A Cloud-Run-shaped constant (`127.0.0.1`) had to be reified into
   its own module with a second constant (`10.200.0.1`) rather than reused.
2. **A digest had to be manufactured because the fleet has no "revision" to
   pin to.** `deploy-pipeline.ts:3255-3305` documents a real incident: the
   fleet branch originally passed the tag `${IMAGE}:latest` — a Cloud Run
   concept (Cloud Run resolves tags itself) — and because the agent only
   restarts on image *change*, an unchanged tag silently served stale code
   while reporting success. Fixed by resolving to a digest once, in a shared
   `buildImage()`.
3. **`maxInstances`/`timeout`/`cpuBoost`/`concurrency` are Cloud-Run-only and
   are explicitly discarded with a log line, not silently**
   (`deploy-pipeline.ts:3678-3697`: *"scale.concurrency=… is NOT enforced on
   the fleet"*). Only `memory`/`cpu` survive, translated into cgroup units by
   `fleet-spec.ts:121-147` — the fleet spec still speaks Cloud Run's own unit
   spelling (`"512Mi"`) at the boundary rather than the pipeline adopting a
   neutral unit.
4. **`envelope.ts`'s `DeployOutcome` grew a second, parallel vocabulary
   instead of a shared interface**: `revisionEnv`/`hasRevision`/`argv` (Cloud
   Run evidence) sit as optional siblings next to `placed?: {memoryBytes,
   cpuShares} | null` (fleet evidence), and the `scale` checker branches
   `if (o.placed) {…} else {…argv…}` (`envelope.ts:279-281`). A documented
   production bug (`envelope.ts:221-227`) came directly from this: the fleet
   branch never populates `argv`, and a check written against Cloud Run's
   evidence shape once threw *after* a successful placement, marking a live
   deploy `failed`.
5. **Domain-mapping decisions were never re-derived for the fleet** — see the
   live bug in §3/§5 below; `resources.ts`'s `domain` resource has no runtime
   field at all.
6. **Siblings force a re-derivation of Cloud-Run-shaped env from scratch.**
   `deploy-pipeline.ts:3093-3128`: a sibling service always deploys to Cloud
   Run even when the primary is on the fleet, so when the primary's DB env was
   computed at `FLEET_DB`, the pipeline must detect that split and recompute
   the sibling's env at `CLOUD_RUN_DB` via `restateDatabaseAt` — a second,
   sibling-only re-derivation of a value the primary's own resolution logic
   never needs.
7. **`fleet-spec.ts`'s `AppSpec` re-derives process/env/secret shapes from
   scratch** rather than reusing the Cloud Run path's resolved objects:
   `shellArgv` (`:157`) re-implements Cloud Run's implicit `/bin/sh -c`
   wrapping; the implicit-web-process rule (`:239-269`) is a second,
   independent encoding of "what counts as this app's web process," with a
   comment citing a real shipped bug where an appended release process
   deleted the implicit web process.
8. **The `AppSpec`/agent `App` struct had already drifted silently once.**
   `fleet-spec.ts:6-13,296-299`: the earlier inline copy was missing `secrets`
   and `processes` — tied by `services/fleet/README.md:12` to why 9 of 47
   apps could not move. Fixed with a dedicated file plus a test that reads the
   Go struct's field set directly, an explicit admission that keeping the two
   shapes in sync by hand had already failed.
9. **No Cloud SQL sidecar equivalent → whole classes of apps refused, not
   translated.** `fleet-place.ts:107-201` (`fleetEligibility`) refuses static
   apps, the runner lane, buildpack apps with no Dockerfile, serviceless apps
   with no Dockerfile, and cron-only apps — five refusals, each because a
   Cloud-Run-only mechanism (sidecar, buildpack builder, metadata-token bundle
   fetch, "a live URL to confirm against") has no fleet counterpart yet.
10. **The LLM repair-agent prompt has to be told which runtime it's fixing, or
    it "fixes" a correct answer.** `apps/web/lib/agent.ts:95-119` injects a
    fleet-specific paragraph warning the model that `10.200.0.1` in
    `DATABASE_URL` is correct and must not be rewritten to `localhost` — the
    address-translation workaround in (1) leaking into a third subsystem.

---

## 3. Where the two paths converge, branch, and branch badly

`deploy-pipeline.ts` has no declarative stage list — stages are recorded
imperatively through a `StageRecorder` (`stages.around`/`start`/`end`/
`skipped`). One structural landmine for future readers: the exported
`runDeploy` (`:1339`) contains an **inner, non-exported closure also named
`runDeploy`** (`:3401-3502`, the Cloud-Run-only delivery path), picked between
against its sibling `runFleetDeploy` (`:3532-3719`) at `:3751-3753`. Grepping
"runDeploy" to find "the deploy function" finds two different things, one of
which is the Cloud-Run-specific half of the other.

### 14 named stages

| Stage | Location(s) | Category |
|---|---|---|
| unpack | `:1175, 1407` | shared |
| clone | `:1418-1420` | shared |
| detect | `:1426` | shared |
| infer-services | `:1518` | shared |
| render | `:1785-1920` | shared |
| activation span | `:1390, 3752-3754` | branches — wraps `toFleet ? runFleetDeploy() : runDeploy()` |
| release | `:2749` (`runRelease`) | target-specific, **Cloud Run only** — never called on the fleet path |
| build (`buildImage`) | `:3351`, called `:3460`/`3534` | shared — the one real choke point (see below) |
| upload | `:1183, 2823` | target-specific — static lane, categorically fleet-ineligible |
| verify (static) | `:1188, 2851` | target-specific, same reason |
| prepare (runner) | `:2959, 3431` | target-specific — runner lane is explicitly fleet-ineligible |
| fleet | `:3699` | target-specific, fleet only |
| repair-agent | `:3911` | branches — `runtime`/`redeploy` parameterized by `toFleet` |
| processes | `:4068` | branches — `processes: toFleet ? FLEET_OWNS_PROCESSES : processes` |

**6 shared, 3 branch, 5 target-specific.** Two more fork points sit outside
any named stage: the runtime choice itself (`:2230-2238`) and the
sibling-service delivery fork inside `deploySibling` (`:2900-3253`).

### Forced convergence points

- **`buildImage()`** (`:3334-3399`) — hoisted above the fork after the
  stale-tag incident (§2.2); both closures call it identically.
- **The activation result shape** — everything downstream (`assertReached`,
  failure classification/rollback, repair-agent dispatch, `markAppLive`, the
  final `send()`) is written once against `{ ok, url?, error? }`, fed
  structurally different evidence by each branch (§2.4).
- **`databaseEnv()`** (`lanes.ts:114-127`) — a genuinely clean convergence:
  one pure function parameterized by a `DbAddress`.
- **"Flip" is split across two files.** `placeOnFleet` (`fleet-place.ts:
  482-659`) does place (`:513-517`, including an early, optimistic
  `setRuntime(slug,"fleet")`) and verify (`:538-574`, with rollback-to-
  previous-placement on failure at `:638-651`), but the actual traffic-facing
  flip — writing `apps.run_url` — happens later, in the **shared**
  `markAppLive(...)` call at `deploy-pipeline.ts:4167`, identical for both
  runtimes. The fleet's own module only gets you two-thirds of the way to
  "flip."

### The badly-branched functions

- **`deploySibling`** (`:2900-3253`) — the worst seam. A ~350-line function
  built entirely around deploying a second Cloud Run service (writes
  `cloudbuild.yaml`, generates a Dockerfile, calls `runRelease`, calls
  `deployArgs`/`gcloudDeploy`, grants IAM invokers, polls `probeApp`) has two
  fleet bolt-ons: a database-address restatement (`:3105-3128`, needed only
  because a split "frontend on fleet + API on Cloud Run" repo would otherwise
  leak an unroutable `10.200.0.1` into the Cloud Run sibling), and an early
  return (`:3166-3201`) that, when `placeOnNode` is true, skips the entire
  back two-thirds of the function (release, deploy args, IAM grant, 30-second
  probe loop) and returns an `AgentProcess` descriptor instead. The doc
  comment at `:2889-2899` is honest that the function does both; the
  implementation is still one Cloud-Run-shaped function with a fork bolted
  near the end, not two functions sharing a build step.
- **`fetchContainerError`** (`:237-258`) — built around `gcloud logging read`
  and Cloud Run's `textPayload` log shape, with a one-line fleet fallback
  bolted into the extraction (`:249-251`, falling back to
  `jsonPayload?.message` for node-shipped log lines).
- **`deployProcesses`** (`:474-605`) has zero internal fleet awareness; the
  fork lives entirely at the call site (`:4068-4087`,
  `FLEET_OWNS_PROCESSES = []`, deliberately empty so orphan-cleanup deletes
  any Cloud Run worker-pools/jobs the app still has). **Two adjacent comments
  contradict each other** about what this branch means: `:4053-4057` says
  "workers and crons still deploy through Cloud Run regardless of which
  runtime serves the web process," while `:4072-4076`, three lines later,
  says the opposite ("The node owns this app's workers and crons, so Cloud
  Run must own neither"). Flagging this as likely-stale documentation, not a
  behavior I could execute-verify — but it is exactly the kind of place a
  reader would get two different answers three lines apart.
- **Two fully independent "does it answer" implementations, not a shared
  seam**: `probeApp` (`:808-866`, Cloud Run ID-token + `SEAL_APPS` semantics)
  vs `fleetProbe`/`fleetVerdict` (`fleet-place.ts:233-316`, load-balancer +
  edge-secret headers, its own retry budget). Both exist to answer the same
  question and share no code.
- **`fleetEligibility`** (`fleet-place.ts:107-201`) — the fleet's own
  gatekeeper has to import and reason in Cloud Run's lane vocabulary
  (`a.lane === "runner"`, `a.lane === "buildpack" && !a.hasDockerfile`), a
  real two-way coupling rather than a one-directional adapter.
- **`release` is a full architectural fork, not a branch.** On Cloud Run it's
  a named stage wrapping a Cloud Run Job (`release-job.ts`). On the fleet, per
  the comment at `:3724-3731`, it never runs as a separate stage at all — the
  release command is folded into the `AppSpec` and run by the node agent
  before processes start. Consequence: fleet deploys produce **no `release`
  row in `deploy_stages`** at all; any reliability analysis reading that table
  is Cloud-Run-only by construction, silently.

---

## 4. The seams that exist — is there a deploy-target interface?

**No.** `Runtime = "cloudrun" | "fleet"` (`fleet.ts:14`) is a plain string
union used as a **field value**, not a discriminant selecting a strategy
object — nothing exhaustively switches on it; every consumer does `=== "fleet"`
with Cloud Run as the implicit `else`. The two execution paths
(`runDeploy`/`runFleetDeploy`) are two long closures inside one file, not two
implementations of a shared interface.

The one real dependency-inversion seam is **`PlacementPorts`**
(`fleet-place.ts:33-75`) — `placeOnFleet` takes an interface of DB/probe/log
functions specifically so place→verify→flip is testable without a database, a
node, or a load balancer. But it only covers the fleet's own placement step;
it has no Cloud Run counterpart and nothing generalizes it into "a deploy
target" abstraction. `chooseRuntime`/`fleetEligibility`
(`fleet-place.ts:107,212`) is the cleanest single decision point in the
codebase, but it only decides the runtime — it doesn't own the two paths that
follow.

**Decision-point count**: ~16 in `deploy-pipeline.ts` fed by one upstream
call, plus 5 independent re-derivations elsewhere (4 API routes + the sync
endpoint) — **21 total**, none unified behind a shared accessor that callers
are forced to go through.

Clean forks (decision made at the top, before unrelated logic):
`chooseRuntime`/`toFleet` (`:2230-2231`), `dbAt` (`:2238`), the
`runFleetDeploy()`/`runDeploy()` dispatch (`:3751-3753`), and each of the 4 API
routes' own top-of-handler check.

Buried forks (mid-function, entangled with unrelated logic):
`deploySibling`'s DB-restatement (`:3109`, 900 lines past the original
decision), the sibling-deploy skip (`:4004`), the one-line `processes` ternary
inside a 20-line object literal (`:4085`), and — the sharpest example —
`:4143`'s `if (!toFleet) await setRuntime(slug,"cloudrun")`, added after a
**real production incident**: an app moved fleet→cloudrun kept
`runtime='fleet'` and its old placement row, and the node went on serving a
second live copy of an app Cloud Run was also now serving. The runtime flag
has at least 3 separate writers (`placeOnFleet`'s success path, its rollback
path, and this line) that all have to agree — proof the decision is not safely
made once, it is re-asserted defensively after having already gone wrong.

---

## 5. What could not move to a VM even in principle today

Distinct from "not built yet" — these require a different data model or trust
primitive, not more code in the existing shape:

1. **Traffic splitting / instant rollback via `update-traffic`.** `fleet_
   placements` (`db/013_fleet.sql`) stores one `spec jsonb` per `(slug,node)`,
   overwritten on every deploy (`fleet.ts:78-86`, `ON CONFLICT ... DO UPDATE`)
   — there is no revision history to roll back to. The platform's own code
   says this plainly: `rollback/route.ts:18-20`, *"a placement holds one spec,
   not a history, so the previous version is not written down anywhere."*
   Fixing this means adding a new concept (versioned placements), not a flag.
2. **Per-request concurrency capping / scale-to-zero.** The agent runs one OS
   sandbox process per app per node; there is no request multiplexer inside a
   sandbox that could cap in-flight requests the way Cloud Run's does per
   container, and no code path that starts additional replicas under load or
   scales to zero when idle. `deploy-pipeline.ts:3693-3695` states this live,
   in a warning shown during real fleet deploys: concurrency is "NOT enforced
   on the fleet — the node does not cap in-flight requests... Your app has to
   limit its own concurrency."
3. **IAM-based service-to-service auth.** Cloud Run's model is a per-caller,
   per-service, Google-signed OIDC token minted fresh per call
   (`services/proxy/src/idtoken.ts:40-49`). The fleet's equivalent
   (`services/fleet/agent/router.go:163-284`) is one shared static secret
   (`FLEET_TOKEN`) checked with a constant-time compare, valid for any app on
   that node, with no caller identity, no per-app allow-list, no expiry — the
   schema comment (`db/016_fleet_process_running.sql`) says outright "any
   holder can post as any node." This is a different trust primitive, not a
   thinner implementation of the same one.
4. **Cloud Run Jobs semantics for release/cron.** A Cloud Run Job execution is
   an isolated, independently retried, independently logged unit with its own
   exit code. The fleet has no such resource — release is folded into a
   resident process's startup ordering (`released` map, `main.go:167-169`),
   and cron runs inside the agent's own process, gated by whether the app's
   other processes are up (`cronBlocked`, `main.go:271-276`), with no
   per-execution sizing/timeout/parallelism the way `cronJobArgs`
   (`process-deploy.ts:232-234`) expresses.
5. **Custom domain mappings via Cloud Run's own domain-mapping API.** This one
   is not hypothetical — it is failing today. See the live bug below.

---

## What the docs get right, and where the code has since diverged (the gap)

DEPLOY-PLAN-V2.md and VM-FLEET.md are largely still accurate on the facts they
assert; the divergence is mostly things that happened *after* VM-FLEET.md was
written (2026-08-04) or that neither doc scoped in:

1. **`services/fleet/README.md:238` is flatly wrong today**: *"The deploy
   pipeline does not know about any of this. A deploy still goes to Cloud Run;
   `fleetctl` places an already-built image by hand."* The pipeline has
   imported `chooseNode`/`placeApp`/`placeOnFleet`/`buildAppSpec` directly
   since the work VM-FLEET.md itself describes as done
   ("Placement moved into the deploy pipeline — 2026-08-04"). VM-FLEET.md is
   correct; the fleet's own README lagged behind it.
2. **Two live bugs exist that neither doc mentions**, both because a
   Cloud-Run-only code path was never re-checked for `toFleet` when the fleet
   branch was added:
   - **Domain mapping.** `resources.ts`'s `domain` decision has no runtime
     field; `deploy-pipeline.ts:4096-4116` only special-cases
     `SEAL_APPS || staticServe`, so a non-sealed, non-static fleet app falls
     through to `createDomainMapping(slug, log)` against a Cloud Run service
     that was deliberately never created for it. The error is caught and
     logged (`! custom domain skipped: ...`), so it doesn't fail the deploy,
     but it's a wasted, confusing `gcloud` call on every such fleet deploy,
     and the app never gets its `<slug>.supersonic.cv` mapping wired the way a
     Cloud Run app does. Contrast with two nearby lines in the *same*
     function (`:4004`, `:4143`) that do check `toFleet` — this is an
     inconsistency within one function, not a systemic gap.
   - **Automatic rollback-on-failure.** `rollBackToLastGood`
     (`:3830-3841`) guards `staticServe || serviceless` but not `toFleet`, and
     is called from all three failure sites (`:3874, 3884, 3976`) regardless
     of branch. For a fleet app it calls `gcloud.ts`'s `rollback()`, which
     does `gcloud run revisions list --service <slug>` — throws for an app
     with no Cloud Run service, caught and logged as noise. **There is no
     functioning automatic rollback for a fleet deploy that fails after
     taking traffic**, even though the surrounding comment names exactly that
     scenario ("the container starts, becomes Ready, then answers 500 to
     everything") as the safety net's purpose. The dedicated `/rollback`
     route is honest about this limitation for manual rollback
     (`rollback/route.ts:18-20`); the pipeline's own internal safety net is
     not — it just tries and quietly fails.
3. **`deleteApp` (`gcloud.ts:530-691`) still touches none of the fleet's
   resources**, as VM-FLEET.md logged as a "note for later" — but the
   consequence is sharper than "the leak stops existing on a fleet, rather
   than getting fixed" (VM-FLEET.md's framing for a fully-migrated future).
   Today, mid-migration, `unplaceApp` is called from exactly one place
   (`fleet-place.ts:642`, only on a *failed deploy's* rollback) and never from
   `deleteApp` or the delete route. The `fleet_placements` row for a deleted
   app is never removed — it becomes untethered rather than orphaned-and-
   swept, because `desiredFor`'s inner join on `apps.runtime='fleet'`
   (`fleet.ts:58-67`) simply stops matching once the `apps` row is gone. If a
   5-character slug is later reused (a scenario `gcloud.ts`'s own comments say
   *will* happen) and the new tenant also lands on `runtime='fleet'`, the
   stale placement row can make a stale node start serving the *old* tenant's
   image under the new tenant's slug. This is a new failure mode, not
   documented in either plan, that only exists because deletion was never
   updated to know the fleet exists.
4. **VM-FLEET.md's own count of decision points understates the current
   surface.** It documents `SEAL_APPS` switching 6 things and the Cloud SQL
   sidecar's 4 emission points (both still accurate), but neither doc
   attempted to count the `toFleet`/`runtimeOf` fork points system-wide; this
   research found **~21** (16 in the pipeline, 5 elsewhere), none behind a
   shared abstraction.
5. **The two contradictory adjacent comments about who owns workers/crons**
   (`deploy-pipeline.ts:4053-4057` vs `:4072-4076`) suggest the docs' framing
   — "the node owns this app's workers and crons" — is the *intended* and
   probably *current* behavior, but the code was edited in a way that left a
   stale comment asserting the opposite three lines away. Worth a maintainer
   pass; flagged here rather than resolved, since it wasn't executable to
   verify from static reading alone.
6. **Release-phase telemetry silently stops existing for fleet deploys.**
   Neither doc mentions that `deploy_stages` — the exact table
   DEPLOY-PLAN-V2.md leans on for its cache/cold-start argument — gets no
   `release` row at all on the fleet path (§3). Anyone using that table to
   reason about release-phase reliability or timing is, without realizing it,
   looking at Cloud-Run-only data as the fleet's share of traffic grows.

## What I could not determine

- `lib/envelope.ts` (`assertReached`, `DeployOutcome`, the `NEVER_ASSERTED`
  list) was not read in full by any sub-agent; claims about it are from call
  sites and comments, not the function bodies.
- `services/fleet/agent/main.go` was read substantially but not exhaustively
  (~1,595 lines, sampled around `reconcileOnce`, cron, fault/health, router);
  `network.go`, `datadir_test.go`, and `fault.go` were only grepped.
  Additional Go-side compensations may exist that weren't surfaced.
- Nothing was executed — all findings are from static reading. The domain-
  mapping and auto-rollback bugs (§ "gap") are inferred from tracing the
  conditionals, not observed in a live failing deploy; it's possible an
  upstream gate (e.g. inside `wants()`'s resource-plan construction) excludes
  fleet apps from the `domain` resource in a way not found by grep.
- Test file contents (`test/fleet-place.test.ts`, `test/fleet-spec.test.ts`,
  `test/fleet-status.test.ts`) were not read — only confirmed to exist and
  referenced as drift guards from source comments.
