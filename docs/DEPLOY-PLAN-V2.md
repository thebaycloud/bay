# One build, N processes, one spec

Supersedes the lane architecture in `DEPLOY-PLAN.md`. That plan closed real
defects — the resolver, assert-consumed, the release job, per-app roles — and
every one of them stays. What it did not do is change the model, and the model is
what the remaining failures come out of.

## The claim

The platform does not deploy containers. It deploys its own idea of an app, and
every app has to survive being translated into that idea. Cloud Run's actual
contract is one sentence: an OCI image, and for a service, one that listens on
`$PORT`. Everything upstream of that is this platform reimplementing, per
language, what a builder already does.

Three changes follow, and they are the whole plan:

1. **One build.** Dockerfile if present, a builder otherwise. The platform names
   no language and stores no version.
2. **N processes.** `web` / `worker` / `cron` / `release`, each mapped to the
   Cloud Run primitive that actually fits it.
3. **One spec.** Emit desired state and replace, rather than patch forever.

## The principle

**The platform's vocabulary contains no proper nouns.** No language names, no
framework names, no version numbers, no package names, no lane names. Anything
specific comes from exactly one of two places:

- the repo's own ecosystem files, read by a builder that already understands them
  (`.python-version`, `runtime.txt`, `requires-python`, `.nvmrc`, `engines`,
  `go.mod`, `.ruby-version`, `global.json`, `rust-toolchain.toml`,
  `.tool-versions`), or
- the user's `supersonic.json`, which we generate once and thereafter only obey.

Every hardcode below is deleted by putting the decision in one of those two
places. The test for any future addition is the same: if the platform has to
learn a proper noun to support an app, the design is wrong.

---

## Verified against the code

Everything in the tables below was checked against the tree at the time of
writing, and the suite was green (587 tests) throughout. Nothing here is broken;
all of it is architectural.

Facts the plan hangs on, with citations:

- `deriveLane` (`apps/web/lib/resolve.ts:112`) is **never called by the server**.
  Its callers are the CLI's vendored copy and tests. The pipeline re-derives the
  lane inline at `deploy-pipeline.ts:1239` from a string match on `s.runtime`.
- `resolveFrom` is called once, at `deploy-pipeline.ts:2056`, inside
  `if (result.ok && appConfig)` — after the deploy, to feed `assertReached`. So
  `ResolvedApp` is a post-deploy auditor, not the thing the deploy reads.
- **Two exported types named `Lane`.** `lanes.ts:21` is
  `static|runner|container|buildpack` (what `deployArgs` executes);
  `stages.ts:5` is `static|fast|generic|runner` (what
  `deploy_stages.lane` records). Same name, two modules, overlapping on two
  values. TypeScript cannot catch it — separate declarations. Postgres cannot
  either — the column is `text NOT NULL`.
- `assertReached` does **not** compare lanes: `lane` is in `NEVER_ASSERTED`
  (`envelope.ts:117`). The vocabulary split is a telemetry defect, not an
  assertion defect.
- `RUNTIME_VERSIONS = { python: "3.14", node: "24" }` exists twice
  (`packages/cli/vendor/detector.js:38`, `resolve.js:751`). One image per
  language (`services/runner/python/Dockerfile:15` → `FROM python:3.14-slim`).
  `resolve.js:766` tells the user to widen their own `pyproject.toml`.
- `LANE_CONSUMES.runner` (`resolve.ts:133`) **lists `runtime`**, so
  `assertConsumed` passes `runtime: "python3.11"` and the app silently gets 3.14.
  This is the exact ignored-but-present defect assert-consumed was written to
  catch, and `DEPLOY-PLAN.md:960` already logged the same failure for `env`.
- No `gcloud run services replace` anywhere. No `--remove-cloudsql-instances`
  or `--clear-cloudsql-instances` anywhere. The stale annotation is also *read*
  by `gcloud.ts:429` to build exec jobs, so the drift propagates into a second
  feature.
- No `--no-cpu-throttling` and no `--min-instances` for any app.
  `scaleServiceFlags` (`lanes.ts:186`) emits `--max-instances`, `--timeout`,
  `--concurrency`, `--cpu-boost` and nothing else. The only `min-instances=1` in
  the repo is the proxy's (`services/proxy/src/tunnel.ts:14`).
- Cron is a Cloud Scheduler HTTP ping at the app's own URL
  (`app/api/apps/[slug]/jobs/route.ts:31`), created with no
  `--oidc-service-account` (`gcloud.ts:232`), while `grantInvokers`
  (`deploy-pipeline.ts:426`) grants only the proxy SA and the control plane.
  Works today only because `SEAL_APPS` defaults off (`deploy-pipeline.ts:59`).
- `provisionStorage` runs unconditionally (`deploy-pipeline.ts:1375`).
  `resources.bucket` (`app-config.ts:423`) and `uses: ["bucket"]`
  (`app-config.ts:559`) are both parsed and read by nothing.
- Procfile is referenced in two places, neither functional: a cache-key file list
  (`plan-cache.ts:65`) and prose inside the LLM planner prompt
  (`opencode-deploy.ts:330`).

### Cloud Run worker pools — verified on the installed SDK

`gcloud beta run worker-pools deploy` (SDK 539.0.0) accepts `--image`,
`--source`, `--command`, `--args`, `--cpu`, `--memory`, `--scaling`,
`--set-env-vars`, `--set-secrets`, `--clear-env-vars`, `--remove-env-vars`,
`--set-cloudsql-instances`, `--clear-cloudsql-instances`, `--container`,
`--depends-on`, `--service-account`, `--labels`, `--region`, `--project`.

It accepts **no** `--port`, no probe flags, no `--allow-unauthenticated`, no
`--concurrency`, no `--timeout`, no `--max-instances`, no `--cpu-boost`.

Two consequences the schema has to respect:

1. A worker has no HTTP endpoint to fake and no startup probe to satisfy. This is
   the primitive a Telegram bot needs. A *service* with
   `--min-instances=1 --no-cpu-throttling` is not — that removes the CPU freeze
   and leaves the port requirement, so the bot still has to pretend to be a web
   server.
2. `Scale` (`lanes.ts:140`) is a **web-shaped type**. `maxInstances`, `timeout`,
   `concurrency` and `cpuBoost` do not exist on a worker pool. Sharing one type
   across process kinds would reproduce, on a new axis, the same
   declared-but-ignored defect this plan is about.

`--scaling` on this SDK takes a positive integer only — a fixed instance count.
Metric-driven autoscaling is not reachable from the CLI yet, so the schema models
`instances: N` and says so, rather than promising a target-utilisation field it
cannot emit.

---

## A. Build and language

| Today | Becomes | Why |
|---|---|---|
| `RUNTIME_VERSIONS` — `detector.js:38`, `resolve.js:751` (two copies) | **Deleted.** Version comes from the repo's own file, honoured by the builder. | Every customer currently shares one interpreter. Unfixable inside the lane. |
| `RUNNER_RUNTIMES = [/^node/,/^python/]` — `resolve.ts:103` | **Deleted.** | This regex is why 80% of the market gets the bespoke path. |
| `Lane = static\|runner\|container\|buildpack` — `lanes.ts:21` | `build: "dockerfile" \| "builder"`. Two values, both language-blind. | "Lane" conflates how it is built with how it runs. Split them. |
| `Lane = static\|fast\|generic\|runner` — `stages.ts:5` | **Deleted**, and `deploy_stages` records the same vocabulary the deploy executes. | Two exported types with one name is why the cache question cannot be answered from data that already exists. |
| `LANE_CONSUMES` — `resolve.ts:131` | **Deleted.** Replaced by `assertReached` on the emitted spec. | `DEPLOY-PLAN.md:960` already concluded a capability list is "a second declaration by the same author" and does not work. |
| `services/runner/{python,node}/Dockerfile`, `RUNNER_*_IMAGE` | **Deleted as a lane.** Survives only as a warm base-image cache keyed by lockfile hash — for every language, not two. | Layer caching gives the redeploy speed generically. |
| `entrypoint.sh:147-160` — package.json→npm, requirements.txt→pip fork | **Deleted.** | The image is already built; nothing installs at container start. |
| `entrypoint.sh:185-186` — Next.js `.next` detection → `next start` | **Deleted.** | The start command comes from the Procfile or the config. |
| `spaDockerfile()`, `nextDockerfile()`, `isNextApp()` — `deploy-pipeline.ts:649/676/700` | **Deleted.** | Generating Dockerfiles by framework name is the matrix this plan exists to remove. |
| `popular-python.txt` (34), `popular-node.txt` (45) | **Deleted.** | Hand-maintained package lists for two languages, forever. |
| `stripQualityGates` rewriting the user's `package.json` — `deploy-pipeline.ts:1260` | **Deleted.** A failing build fails. | Silently editing a customer's build script to make a deploy pass is the wrong side of a line. |
| `BASE_IMAGE_BINS`, `PYTHON_SERVERS` — `plan-deps.ts:23,38` | **Deleted.** The build fails loudly on a missing binary. | These exist only because the runner ships a fixed image. |
| `--clear-base-image` retry — `deploy-pipeline.ts:2029` | Keep. | A genuine builder quirk, not a hardcode. |

### Which builder

"Dockerfile, else buildpack" is not "any language", and saying so would repeat
the promise the product cannot hold. Google buildpacks cover Node, Python, Go,
Java, Ruby, PHP and .NET — no Rust, Elixir, Deno or Bun.

So the builder is **a declared field with a default**, not a constant:

```json
"build": { "builder": "auto" }
```

`auto` = Dockerfile if present, else Nixpacks. Nixpacks (MIT) covers Node, Deno,
Bun, Python, Go, Rust, Elixir, Java, PHP, Ruby, .NET, Swift, Haskell, Zig and
Crystal, reads the same ecosystem version files, and emits an OCI image, which is
all Cloud Run wants. `buildpacks` and `dockerfile` stay selectable.

Adding a language is then never a code change here. Publish the coverage table as
"what the builder covers today" — a number that moves without us shipping.

---

## B. Processes — the flexibility fix

The schema has one expressible shape: one HTTP server on one port. `validate`
hard-fails any non-static, non-container service without a `start`
(`resolve.ts:341`); health defaults to `GET / → 200` (`resolve.ts:166`); every
entry gets a `path` prefix (`app-config.ts:188`). A worker has nowhere to exist.

| Today | Becomes | Primitive |
|---|---|---|
| `start` — the one long-running command | `processes: { web, worker, cron, release }`, from `Procfile` when present | — |
| every service is HTTP | `web`, optionally several | `gcloud run deploy` |
| no worker primitive at all | `worker` | `gcloud beta run worker-pools deploy` |
| cron = Scheduler HTTP ping at the app's own URL (`jobs/route.ts:31`) | `cron` with a schedule | `run jobs` + Scheduler triggering **the job** |
| release job, already close | `release` | `run jobs` + execute |
| no way to say "HTTP, but not public" | `web` + `visibility: "internal"` | `--ingress=internal` |

`visibility` is an orthogonal field on `web`, not a separate process kind. An
internal `web` beside a `worker` is exactly the agent-server shape, and it
composes without a fourth type.

### What each kind may declare

Deliberately **not** one shared `Scale`. The primitives differ, and a field a
primitive cannot emit is the defect this whole plan is named after.

| Field | web | worker | cron | release |
|---|:--:|:--:|:--:|:--:|
| `command` | ✓ | ✓ | ✓ | ✓ |
| `cpu`, `memory` | ✓ | ✓ | ✓ | ✓ |
| `visibility` | ✓ | | | |
| `health` | ✓ | | | |
| `maxInstances`, `concurrency`, `cpuBoost`, `timeout` | ✓ | | | |
| `instances` (fixed, `--scaling N`) | | ✓ | | |
| `schedule` | | | ✓ | |
| `taskTimeout`, `retries` | | | ✓ | ✓ |
| `shutdownGrace` | ✓ | ✓ | | |

### Graceful shutdown

A worker draining a queue gets SIGTERM on every deploy and every scale-down.
Losing the in-flight task is data loss, not an inconvenience, and it is the
single most likely thing to bite the app types this plan exists for.

Cloud Run's service default is SIGTERM then roughly 10s to SIGKILL.
`terminationGracePeriodSeconds` is **not reachable from any `gcloud run` flag** —
it is a spec field. So `shutdownGrace` is emittable only on the YAML path, which
is section C. Until C lands, the field parses, validates, and is reported as
not-yet-emitted rather than silently dropped.

This is also the strongest argument for C's position in the order: without
desired-state emission there is no way to set it at all.

---

## C. State — patch to reconcile

| Today | Becomes | Why |
|---|---|---|
| `--update-env-vars` / `--update-secrets` everywhere (`deploy-pipeline.ts:1552`, `1901`, `release-job.ts:263`) | Emit a full spec, `gcloud run services replace` | Merge-forever means every app drifts into an unreproducible configuration. |
| nothing removes `run.googleapis.com/cloudsql-instances` | Gone by construction — the spec states the annotation set | The stale annotation is read by `gcloud.ts:429`, so drift propagates into exec jobs. |
| `existingScoped` / `liveContainerShape` (`lanes.ts:241`, `deploy-pipeline.ts:306`) | **Deleted.** The spec states the container set. | Roughly sixty lines of comment explaining a problem that exists only because we patch. |
| orphaned plaintext secrets from older code paths | Gone — the spec states the full env | |
| first `replace` against an already-drifted live service | Guarded by a `--dry-run` diff shown before apply | This is where a running customer app gets taken down. Non-negotiable. |

Worker pools already accept `--set-env-vars` / `--clear-env-vars`, so the worker
path can be desired-state from day one without waiting on C.

---

## D. Resources and bindings

| Today | Becomes | Why |
|---|---|---|
| `databaseEnv()` writes 17 fixed names — `lanes.ts:63-73` | Platform injects `DATABASE_URL` only; anything else the app maps itself | Seventeen guessed names is a bet that we enumerated every framework's spelling. |
| `DATABASE_OWNED_PREFIXES`, `platformOwned()` — `app-config.ts:225,242` | **Deleted.** Nothing to protect once one name is injected. | Today this refuses a user's `PGBOUNCER_URL` on a managed database. |
| `ownedBecause()` — `app-config.ts:318` | **Deleted.** | A function whose job is apologising for a rule that should not exist. |
| `engine !== "postgres"` → refuse — `app-config.ts:414` | `type: postgres \| mysql \| redis`; unknown types get a clear not-yet message | A CRM wants Redis. |
| `provisionStorage` unconditional — `deploy-pipeline.ts:1375` | Gated on `uses: ["bucket"]` | Already logged at `DEPLOY-PLAN.md:999`. |
| `frameworkEnv()` — Django/Rails/Next/FastAPI matrix, `framework-env.ts:52-99` | **Deleted from runtime.** Written into the generated `supersonic.json` at init, as ordinary `env` the user can see and edit. | Moves framework knowledge from our code, where it must be exhaustive, into their file, where it is a starting point. |
| `frameworkBuildEnv()` — `framework-env.ts:107` | Same treatment, into `buildEnv`. | |
| `CLOUD_SQL_PROXY_IMAGE` pinned — `lanes.ts:43` | Keep pinned. | Our infrastructure, not the user's language. |
| `DEFAULT_SCALE.memory = "2Gi"` — `lanes.ts:151` | Keep as the `web` default; per-process overridable | A defensible floor, but it should not be one number for every process kind. |

### Typed interpolation

One namespace, everything typed, resources *and* services — because multi-service
apps need each other's addresses, which is `siblingUrls` in `DeploymentFacts`
(`resolve.ts:32`) today and would otherwise be lost:

```
${db.url}   ${db.poolUrl}  ${db.host}  ${db.port}  ${db.user}  ${db.password}  ${db.name}
${api.url}  ${api.host}    ${api.hostport}         ${api.internalUrl}
${app.url}  ${app.hostname}
${generate(32)}
```

`${generate(n)}` is a random value the platform mints once and stores. Small
feature, large return for this market: agent-written apps ask for
`SESSION_SECRET` / `JWT_SECRET` / `NEXTAUTH_SECRET` and ship a placeholder, and
that is a deploy failure we currently own.

---

## E. Schema

| Today | Becomes | Why |
|---|---|---|
| `language: node\|python\|static\|other` — `app-config.ts:95,199` | **Deleted.** | The field exists only to pick a lane. `"other"` is an admission the enum was wrong. |
| `runtime: "python3.12"` — declared, listed as consumed, not honoured | **Deleted.** Use the repo's own version file. | Today this is precisely the silent ignore `assertConsumed` was written to catch. |
| `services: [{ path, start, health }]` | `services: [{ path, processes: {…} }]` | |
| `preDeploy` / `release` — `app-config.ts:120,130` | `release` only; `preDeploy` warns | |
| `needsDB` / `uses` — `app-config.ts:152,157` | `uses` only; `needsDB` warns | |
| `env: [...]` array vs object — `app-config.ts:469` | object only; array warns | Three deprecated dual-spellings is enough surface to be its own bug class. |

---

## F. Detection and inference

| Today | Becomes | Why |
|---|---|---|
| `BROWSER_FACING` — `infer-services.ts:53` | the process named `web`, else declaration order | |
| `NODE_FRAMEWORK` — `infer-services.ts:74` | "has a manifest the builder recognises" | |
| `PYTHON_ENTRIES` / `PYTHON_RUNNABLE` / `pythonModule()` / `pythonInstall()` — `infer-services.ts:56,77,155,188` | **Deleted.** The Procfile says it, or `supersonic init` asks once. | ~80 lines that exist to guess a module path uvicorn will accept. |
| `bindToPort()` regex-rewriting `--port 8000` — `infer-services.ts:139` | warn, do not rewrite | Rewriting a customer's start command by regex is an unverifiable guess. |
| `NOT_AN_APP` — `infer-services.ts:67` | Keep. | Genuinely generic; no proper noun in it. |
| two lane derivations (`resolve.ts:112` vs `deploy-pipeline.ts:1239`) | one; `resolveFrom` moves to the **top** of the deploy | Live correctness bug. |
| planner in the critical path (40–180s, non-deterministic) | Procfile → `supersonic.json` → planner, in that order | Two deterministic sources before paying for a model. |

---

## What the 40 seconds becomes

Redefined, not deleted. Today: 40s for two languages, on a path that cannot
honour a version file. After: a cold build of 2–4 minutes for any language, and a
warm redeploy with an unchanged lockfile in seconds — because layer caching
applies to Go, Ruby, Java and PHP too. We lose the cold number on Node and Python
and gain it everywhere else, and gain the ability to run a bot at all.

State it as a warm-cache best case rather than as the architecture.

### Measure it before step 6

`deploy_stages` already has a `lane` column with data (`004_deploy_stages.sql`).
Two things stop it answering the question:

- it records `stages.ts`'s vocabulary (`fast`, `generic`) while the deploy
  executes `lanes.ts`'s (`buildpack`, `container`), and nobody wrote the mapping
  down;
- there is no `runtime` column and no cold/warm flag. `apps.release_hash`
  (`005_release_hash.sql`) is null for every cloud build, so it cannot stand in.

Unify the type, add `runtime text` and `cold boolean`. That is the hour of work
that turns step 6 from an argument into a number.

---

## What Cloud Run will not do

Written down rather than routed around, because "any app" is the promise this
plan is trying to make true, and an unstated limit is how it becomes false again.

- **No persistent disks.** Render has `disk: {name, mountPath, sizeGB}`. Cloud
  Run has GCS FUSE, which loses writes under concurrency, or Filestore at roughly
  $123/month minimum. Anything needing a real writable volume — SQLite,
  Elasticsearch, uploads served from local disk — does not belong here yet.
- **No metric-driven worker autoscaling from the CLI.** `--scaling` takes a fixed
  integer on SDK 539.0.0.
- **`shutdownGrace` needs the YAML path.** No `gcloud run` flag sets
  `terminationGracePeriodSeconds`.
- **Request ceiling is 60 minutes.** Anything longer is a job, not a `web`.
- **Builder coverage is the builder's, not ours.** Rust, Elixir, Deno and Bun are
  Nixpacks-or-Dockerfile; they are not "any language" for free.

---

## Order

1. ~~**Process model**~~ — landed. The schema, the Procfile reader, and the
   worker-pool primitive. First because the primitive decides the schema shape: a
   pool has no port and no health path, and a schema that first describes a worker
   as a service-with-a-port has to be rewritten.
2. ~~**Emit the primitives**~~ — landed. Worker pools, cron jobs with OAuth (not
   OIDC — see the log), `web` unchanged.
3. ~~**Telemetry**~~ — landed. One `Lane` type; `runtime` and `cold` on
   `deploy_stages`.
4. **`services replace`** with a dry-run diff. Unlocks `shutdownGrace` and kills
   drift as a class. **Next** — and the last change that touches how `web` itself
   is deployed, so it is the one that needs the diff before it runs anywhere near
   a live service.
5. **Collapse the two lane derivations** — landed. Moving `resolveFrom` to the
   top of the deploy is what remains, and belongs with the pipeline wiring.
6. **One build path**, builder as a field — after step 3 has data.
7. **Typed interpolation** and `${generate(n)}`; delete the 17 names and the
   protected-name rules.

## Implementation log

### Step 1 — process model (landed)

`lib/procfile.ts`, `lib/processes.ts`, and `processes` in the config schema, with
tests. Pure and unwired: nothing in `deploy-pipeline.ts` reads them yet, so this
cannot change a deploy that works today. Step 2 is what connects them.

Suite: 618 web tests (up from 587), 93 CLI tests, `tsc --noEmit` clean. The
vendored resolver was rebuilt, so `supersonic check` and the control plane apply
the identical rule — the one-rule-many-readers defect the previous plan is named
after, not reproduced inside its successor.

Decisions taken here that the plan left open:

- **A config declaring `processes` is REFUSED, not accepted-and-ignored.**
  Landing a schema ahead of its executor is only safe if the schema says so. Two
  plans have now been spent closing exactly one defect — `env` set on nothing,
  `release` never run on the container lane, `uses: ["database"]` provisioning no
  database, `runtime` listed as consumed by a lane with one image per language —
  and every instance was a field accepted, validated, printed back and not
  applied. The refusal names the step that will lift it and is a single block in
  `parseAppConfig` to delete.

- **Four kinds, not three.** `release` is a process rather than a special field.
  It already runs as a Cloud Run job (`release-job.ts`); making it a kind means
  one emitter instead of a job path plus a `release` string.
- **`Procfile` is authoritative when present, and `processes` is authoritative
  over `Procfile`.** A repo carrying both is not an error — a Procfile is what
  the app already had, and `supersonic.json` is what someone wrote for us. But
  declaring the same kind in both with different commands *is* refused, on the
  same rule that refuses `preDeploy` beside `release`: two spellings of one field
  where silently preferring either leaves the other looking ignored.
- **Per-kind sizing types rather than one `Scale`.** See section B. `WebScale`
  keeps every field `Scale` has today so `web` is bit-for-bit unchanged;
  `WorkerSize` and `TaskSize` carry only what their primitives accept.
- **`instances` is a fixed count.** Not `{min,max}`, because `--scaling` cannot
  express a range on this SDK. A field the primitive cannot emit is the defect
  this plan is about.
- **`shutdownGrace` parses and does not emit.** Recorded by
  `unemittable()` so it is reported rather than silently dropped, and it starts
  emitting the moment step 4 lands.
- **`timezone` on a cron.** Added during step 2, once the Scheduler argv made it
  free: `--time-zone` is one optional flag, and without it "0 3 * * *" is 3am UTC,
  which for a business in Almaty is 8am — during the working day, against live
  traffic. Sent only when the author said which zone they meant.

### Step 2 — emitting the primitives (landed)

`lib/process-deploy.ts`, with `lanes.ts` split so the Cloud SQL sidecar has one
source. 638 web tests, 93 CLI, `tsc --noEmit` clean.

**Verified against real gcloud, not just against assertions.** Each emitter's
argv was run through `gcloud` against a project that does not exist. All three
parsed every flag and failed at the API layer with `PERMISSION_DENIED`, which is
the only outcome that proves the flags are right without creating anything:

- `beta run worker-pools deploy` — multi-container, `--scaling=2`, `^~~^` escapes
- `run jobs deploy` — sidecar with `--depends-on` and the startup probe
- `scheduler jobs create http` — `--oauth-service-account-email`, `--time-zone`

Decisions taken here that the plan left open:

- **OAuth, not OIDC, for a scheduled job.** The plan said OIDC and the plan was
  wrong. A scheduled cron triggers the Cloud Run Admin API at
  `{region}-run.googleapis.com/…/jobs/{name}:run`, and a Google API wants an OAuth
  access token. OIDC mints an identity token for an arbitrary audience — correct
  for calling a private Cloud Run *service*, a 401 here. `gcloud scheduler jobs
  create http` offers both flags, so nothing about the mistake would have surfaced
  until the first scheduled run failed.
- **No `--depends-on` on a worker pool.** Cloud Run refuses any revision whose
  `--depends-on` names a container with no startup probe, and a worker pool
  exposes no probe flag at all — so the precondition cannot be met and emitting
  the flag would mean a revision rejected after the build for a reason unrelated
  to the app. Ordering is handled by `proxyWait()` in front of the command, which
  is where every non-runner release already handles it, and which is strictly
  stronger: `--depends-on` orders container START, not port readiness.
- **The worker's `app` container is named unconditionally.** Not only when there
  is a database. The container set is not idempotent — adding a name to a pool
  deployed without one rewrites its containers, which is the trap `existingScoped`
  exists to work around on the service path. A pool named from its first revision
  never has that transition to survive.
- **Worker and cron env is `--set-*`, never `--update-*`.** These primitives have
  no deployed instances anywhere, so they are born reconciled: a variable dropped
  from the config is gone from the next revision. An empty environment emits
  `--clear-env-vars` rather than nothing, because omitting inherits. The service
  path stays on `--update-*` until step 4, where changing it means rewriting live
  services and needs the dry-run diff.
- **`--ingress=all` is stated explicitly for a public web.** Omitting it leaves
  whatever the service already had, so an app that was internal and becomes
  public would stay unreachable with a config saying otherwise — a silent no-op on
  the one field whose whole purpose is to be observable.
- **`web` keeps the service's own name; every other process is suffixed.** A
  Cloud Run service called `myapp-web` beside a domain mapping for `myapp` would
  be a rename of every app that already exists. Capped before the suffix, so two
  apps with a long shared prefix cannot truncate onto one resource.

### Step 3 — telemetry (landed)

`db/011_stage_lane_vocabulary.sql`, `lib/stages.ts`, and the three writers.
641 web tests, 93 CLI, `tsc --noEmit` clean.

`lib/stages.ts` no longer exports a type called `Lane`. It imports the one from
`lib/lanes.ts` and widens it to `StageLane = Lane | "unknown"`, and the pipeline
records the vocabulary it executes.

- **`unknown` is a value, not null.** `generic` was doing two jobs: the lane a
  Dockerfile app takes, and what the recorder writes before any lane is chosen.
  One string for two facts is why `lib/analytics/attempts.ts` carries
  `LANE_BLIND_STAGES`. With an explicit `unknown` that set becomes a fallback for
  old rows rather than the mechanism.
- **The migration disambiguates rather than guessing.** `fast` → `buildpack` is
  unambiguous. `generic` is split by stage, using the same rule the analytics
  layer already trusts: on a stage that runs before the lane is chosen it meant
  "not known", on any later stage it meant the container lane.
- **A CHECK constraint, and a test that reads it.** `STAGE_LANES` (values, not a
  type) is derived from `ALL_LANES` in `lib/lanes.ts`, and `test/stages.test.ts`
  parses the migration's `CHECK (lane IN …)` and asserts the two sets are equal.
  That pairing is the actual fix — two vocabularies could coexist precisely
  because nothing anywhere asserted they were one set.
- **`runtime` and `cold` columns.** `cold` is "no live Cloud Run service yet",
  read once at the moment the lane is known. Null for the static lane, which
  publishes to GCS and has no service to be absent, and null when the API call
  fails — a wrong value in a column that exists to settle an argument is worse
  than an absent one. Telemetry can never fail a deploy, so `isFirstDeploy`
  cannot throw.
- **No index for the two new columns.** The query they exist for is run by a
  person deciding a build strategy, not by a request, and an index on a
  pre-existing table has to be built `CONCURRENTLY`, which cannot run inside the
  transaction the rest of the migration needs. `deploy_stages_started_at_idx`
  already bounds it to the window being asked about.

### Step 5 — one lane decision (landed)

`deriveLane` in `lib/resolve.ts` was called by the CLI and by `resolveService`,
and by nothing in the deploy: `deploy-pipeline.ts` derived its own lane inline
from a string match on the detector's runtime. Two functions, two rule sets, and
`assertConsumed` validating a service against a lane the deploy might not take —
so a config could resolve to `runner` in `supersonic check` and deploy on
`buildpack` with nobody informed.

Both now call `laneFor(inputs)`. The two facts only the pipeline knows — the
`RUNNER=1` flag and whether an agent supplied a run command — became inputs
rather than a reason for a second function. `deriveLane(ServiceConfig)` is a thin
wrapper that answers what a FILE says, with `runnerEnabled` defaulting to true so
a server env var does not leak into `supersonic check`.

Behaviour-preserving, and asserted that way: `test/resolve.test.ts` locks the
pipeline's full truth table — ten rows of (runtime, Dockerfile, RUNNER, agent
`--run`) — against the shared function.

### Step 2b — wired into the pipeline (landed)

`lib/process-plan.ts` plus a call site in `deploy-pipeline.ts`. 656 web tests,
93 CLI, `tsc --noEmit` clean, `next build` clean. The `processes` refusal in
`parseAppConfig` is gone.

**Additive by construction.** `web` deploys exactly as before, `release` still
runs through `release-job.ts`, and everything the planner emits is a resource
that did not previously exist. An app declaring no processes takes a path
identical to yesterday's.

- **The planner is pure and the call site is a loop.** Every decision is in
  `process-plan.ts` and every argv in `process-deploy.ts`, so the imperative half
  is about thirty lines. That is the whole reason for the split.
- **Removal, not just creation.** `orphans()` diffs the LIVE set against the
  planned one and deletes what the config no longer describes. Emitting desired
  state per resource is worth little if the SET is still patched: an app that
  deletes its `emails` worker would otherwise keep a pool running the old command
  — billed, draining a queue nobody reads — which is the stale-cloudsql-annotation
  defect reproduced inside the feature built to end it.
- **A cron is two resources.** Deleting only the job leaves a schedule firing
  every night at a target that is not there, and Scheduler retries a failing
  target — so the residue is an error every night forever for a deleted feature.
  The schedule goes first, so there is no window where one exists without the
  other.
- **Found by label, not by name prefix.** `listJobs` in `lib/gcloud.ts` matches on
  `slug--`; an app called `crm` and one called `crm-worker` share that prefix, so
  a prefix rule could compute another customer's resources as orphans. The job
  filter also requires `supersonic-process:*`, so the app's own release job — which
  carries the parent label — is never seen as one.
- **The command's delivery depends on the lane.** On the runner the image is a
  shared base whose entrypoint fetches the bundle and execs `$SUPERSONIC_RUN`;
  overriding it with `--command` would run the worker against an empty `/app`.
  Every other lane runs the app's own image, whose CMD is the web server, so
  there it must be overridden. Exactly the split `releaseJobArgs` makes, made once.
  `SUPERSONIC_RUN` replaces the web process's value rather than being appended —
  two in one `--set-env-vars` would leave the winner to gcloud, and the worker
  would serve HTTP.
- **Workers run the same artifact as the web process.** On the buildpack lane the
  image does not exist until `run deploy --source` has run and Cloud Run has named
  it, so it is read back off the live service. Handing each worker `--source`
  would pay for the whole build again per process, on a lane whose release job
  already pays for it twice. No image means no deploy, loudly — never a third
  build from a source tree.
- **Failures are non-fatal but not silent.** A worker that does not come up leaves
  an app whose web service is live, and tearing that down is strictly worse — same
  rule a sibling follows. Each failure is logged and written to the deploy row,
  and a summary is thrown after the cleanup pass so the `processes` STAGE records
  a failure. A stage reporting "ok" while a worker never started would be
  telemetry that agrees with the code rather than with what happened.
- **A Procfile is read from the SERVICE's directory.** A config with
  `dir: "backend"` runs its commands there, so that is where its Procfile is;
  reading the root's would hand a monorepo's frontend Procfile to its API.

### Step 2c — worker-only apps (landed)

A Telegram bot is a worker and nothing else: no HTTP, no port, no URL, no domain
mapping, nothing to probe. Deploying a Cloud Run service for it anyway puts the
bot straight back to pretending to be a web server, which is the defect this plan
exists to remove. 659 web tests, 93 CLI, `tsc --noEmit` and `next build` clean.

- **`isServiceless` turns on having DECLARED.** An app with no `processes` is not
  a worker-only app — its `start` command is its web process under an older
  spelling, and it must take yesterday's path exactly. Only an app that said what
  it runs, and did not say `web`, is serviceless. That guard is the difference
  between a feature and an outage.
- **One skip, not one per lane.** Every lane reaches `gcloud run deploy` through
  `attempt()`, so the guard lives there. Prepare, build and release are untouched
  — they are what produces the artifact the workers run — and no future lane can
  be added that forgets to honour it.
- **Except buildpacks, where the build IS the deploy.** `--source` builds inside
  `run deploy`, so with no service there is nothing to produce an image.
  `gcloud builds submit --pack=image=…` is the same builder without the deploy.
  Deliberately not `--source` on the worker pool, which accepts one: that would
  rebuild the app once per process, on the lane whose release job already pays
  for the build twice and says so.
- **No URL, said plainly.** `Running — this app has no web process, so it has no
  URL.` No domain mapping (it would point a hostname at a service that does not
  exist), no thumbnail (there is no page, and the shot service would photograph
  an error and leave it on the dashboard as this app's picture), and no `url` on
  the done event, which would be a dead link.
- **`supersonic check` had to change too.** `validate` refused any non-container
  service without a `start`, so the CLI rejected a valid bot config. It now
  accepts a service that declares `processes` instead, and the refusal for a
  service declaring neither names the alternative. `processes` is in
  `LANE_CONSUMES` for the three container lanes and NOT for `static` — a static
  site is files in a bucket, with no container to run a bot in, so refusing there
  is correct.

All four shapes now deploy: **bot** (`worker`), **agent server** (`web` +
`worker`), **CRM** (`web` + `cron` + `release`), **web** (unchanged).

### What still cannot deploy

**A Procfile `release:` line does not run.** The release phase has its own path
that already knows what is easy to get wrong there, and a second implementation
is the defect this plan is named after. Said out loud during the deploy, naming
the `supersonic.json` field that does work.

**Sibling processes are refused.** A sibling's workers need the sibling's own
image and env, which `deploySibling` does not build in a shape the planner can
reach. Refused rather than accepted and skipped.

### Live risk, unchanged by these steps

`SEAL_APPS` must not be flipped to `1` before step 2 is wired into the pipeline.
The existing cron path (`lib/gcloud.ts:232`) passes no auth flag, and
`grantInvokers` binds only the proxy SA and the control plane — so today's crons
work solely because apps deploy `--allow-unauthenticated`. `cronScheduleArgs`
replaces that path rather than patching it, so the fix arrives with the wiring;
until then the flag is the thing to leave alone.
