# Make deploys work — the complete build

> ## Status, 3 Aug — read this first
>
> **The cutover is live.** `_LANE_ENV` in `cloudbuild.yaml` carries `RUNNER=0`,
> so every app without a Dockerfile of its own now builds a generated image.
> Verified in production before flipping, not after: a Node app deployed through
> the collapsed path, buildx pulled its daemon from the mirror, `FROM` resolved
> through it, the per-app cache repo was written, the build ran as a scoped
> service account, and the service answered 200.
>
> Roll back by setting `_LANE_ENV` to `RUNNER=1` and pushing.
>
> | Row | Status |
> |---|---|
> | 0 stamp manifest, buildkit prerequisites | **done** — stamp derives from esbuild's metafile; `docker-hub` pull-through repo created; canary measured 44s cold / 15s warm |
> | 1 `detect.ts`, `repo-runtime` rewrite | **done and wired** |
> | 2 manifest COPY, templates, `proxyWait` | **done and wired** |
> | 3 build secrets, `buildEnv` | **done** |
> | 4 collapse, siblings, `check` | **done** — `RUNNER_ENABLED` re-scoped to select a build implementation |
> | 5 buildkit default, base mirror, digest pinning | 2 of 3 — **digest pinning not done** |
> | 6 build SA, registry GC, slug reuse, deploy cap | 3 of 4 — **per-owner in-flight deploy cap not done** |
> | 7 stage the pipeline | vocabulary, render split and a real harness done; **`runDeploy` is still one 1700-line function** |
> | 8 `classify`, repair channel | verdict-scoping and the patch pathspec done; **Dockerfile persistence and rerender-on-repair not done** |
> | 9 Dockerfile cache, config write-back | **not started** |
> | 10 backfill, decommission | query done (`scripts/runner-decommission.sh`); **backfill not done — see below** |
> | 11 auto-rollback, watch, backups | **not started** |
>
> ### Three things this work found that the plan did not know
>
> **The backfill cannot be fully automated.** `scripts/runner-decommission.sh`
> reports **17 services still on the runner**. An upload-path app's source exists
> only as the encrypted per-deploy bundle in `ready/<slug>/`, readable only by
> that app's own revision — a git-deployed app can be re-cloned, an uploaded one
> cannot be reconstructed from anything the platform holds. Until those 17 are
> redeployed by their owners, `services/runner/` cannot be deleted: `build.sh` is
> the only thing that builds the images they cold-start from.
>
> **`cloudbuild.yaml` env never reached the deploy job.** The job step updated
> only `--image`, and `DEPLOY_JOB=1` means the job is where deploys execute — so
> every flag in that file described what the *service* would have done. Found by
> setting one and watching a build come out as the old identity anyway. Both
> steps now read one `_LANE_ENV` substitution.
>
> **The plan's canary was not expressible.** `BUILDER` is read from the job's
> environment, which every deploy shares, so "canary on one app" would have
> applied it to all of them first. `BUILDKIT_APPS` was added for that.
>
> Row 6's `LIMITS` gap is worth doing before customers: build-seconds per deploy
> are now 3–6× higher and nothing throttles.


Written against the whole of `deploy-pipeline.ts` (2,883 lines), `resolve.ts`,
`dockerfile.ts`, `repo-facts.ts`, `repo-runtime.ts`, `build-config.ts`,
`release-job.ts`, `services/runner/*`, and the CLI. Every capability the pipeline
has today is listed below and marked keep / change / delete, so nothing is
discovered halfway through.

**Revision 2.** The first draft was audited against the code it describes. Its
diagnosis held — the generated Dockerfile really is gated at
`deploy-pipeline.ts:1596` and really does run for almost nobody. What did not
hold was the delete/keep split: several items marked "Keep — do not touch" are
built out of items marked delete, and three capabilities that exist only inside
the runner had no replacement named. The changes:

- `BuildSpec` gains `framework`, `database`, `release`, and a per-directory
  `toolchains[]`. Without the first three, three Keep-list items go dark.
- **Build-time secrets** get a section. `runnerPrepareConfig` is the only build
  config in the repo that mounts them; deleting it without a replacement
  regresses every Prisma app.
- Version strings get a **resolve-and-validate** step. They are interpolated
  into `FROM` unvalidated today, which is survivable behind the `runtimePinned`
  gate and is not survivable as the only path.
- The manifest `COPY` gets rewritten before the deletion, not after. It is
  root-only and hard-fails on zero matches.
- `RUNNER_ENABLED` is re-scoped. Its two branches today are runner and
  buildpack — both of which the first draft's collapse step deleted, which left
  the migration with no rollback.
- New **Part 9**: build identity, registry lifecycle, slug reuse. Not mentioned
  in the first draft and not covered by any other row.
- Order table re-costed: 19 days → 30, with four rows that did not exist.

---

## Part 0 — What the pipeline does today

The full inventory. Read this once; the rest of the document refers back to it.

### Entry and source

| # | Capability | Where |
|---|---|---|
| 1 | `--prebuilt`: client builds, uploads an archive, we publish to GCS | `deploy-pipeline.ts:1268`, `publishPrebuilt` |
| 2 | Upload (tar) or git clone, with clone reuse from `/api/detect` | `:1265–1299`, `takeClone` |
| 3 | Broken-symlink pruning (the FastAPI template ships dangling `.venv` links) | `pruneBrokenSymlinks:819` |

### Deciding what the app is

| # | Capability | Where |
|---|---|---|
| 4 | Detector subprocess → framework, language, confidence, db, secrets | `:1301` (`npm run detect`) |
| 5 | `supersonic.json` read → `planFromConfig`, replaces the planner entirely | `:1361` |
| 6 | Multi-service inference — one repo split into N services | `inferAppConfig:1393` |
| 7 | LLM planner (`planDeploy`), 40–180s, with a content-hash plan cache | `:1468`, `plan-cache.ts` |
| 8 | Refuse rather than guess when the planner fails on a multi-language repo | `refusalReason:1629` |
| 9 | Runtime pin read from 5 files → `runnerServes` yes/no | `:1439–1449` |
| 10 | `ensureRunDeps` — start command's binary vs `BASE_IMAGE_BINS` | `:1542` |
| 11 | Static-vs-server adapter check for Astro and Next (SvelteKit has none) | `services/deploy-agent/src/index.ts:85–98` |
| 12 | Database inference from dependency names (prisma/django/sqlalchemy/…) | `deploy-agent/src/index.ts:163–169, 214–218` |

### Building

| # | Capability | Where |
|---|---|---|
| 13 | **runner** — no image; prepare once, upload encrypted bundle, shared base image | `:2495–2530` |
| 14 | **container** — `builds submit` with layer cache (kaniko/buildkit) | `:2532–2554` |
| 15 | **buildpack** — `run deploy --source`, plus `--clear-base-image` retry | `:2585–2602` |
| 16 | **static** — build assets, `storage rsync` to GCS, move a pointer | `runStatic:2245` |
| 17 | **serviceless buildpack** — `builds submit --pack`, no service | `:2556` |
| 18 | Generated Dockerfile — **only when `runtimePinned` and no Dockerfile** | `:1596` |
| 19 | `spaDockerfile` / `nextDockerfile` by framework name | `:1705–1712` |
| 20 | `stripQualityGates` rewriting the user's `package.json` (static lane) | `:1694` |
| 21 | **Build-time secrets — runner prepare only** | `runnerPrepareConfig:326`, `buildSecrets:1973`, `grantBuildAccess` at `:2377, :2507` |
| 22 | Image push to one shared Artifact Registry repo, tag `:latest` | `:2104, :2549` |

### Provisioning and wiring

| # | Capability | Where |
|---|---|---|
| 23 | `planResources` — attach/release for database, bucket, db-proxy, domain, invoker | `:1802` |
| 24 | Cloud SQL Postgres + per-app role, started early, awaited late | `provisionPostgres:553` |
| 25 | External database (`provider: "external"`) — provisions nothing, validates the secret exists in 3 places | `:1781, 1844` |
| 26 | GCS bucket, gated on `uses: ["bucket"]` / `resources.bucket` | `provisionStorage:636` |
| 27 | Secret Manager for app secrets; build secrets are a filtered subset | `:1976`, `buildSecrets:1973` |
| 28 | `mergeDatabaseEnv` — a name is a secret or plain, never both | `env-merge.ts` |
| 29 | `databaseEnv` — 17 spellings of the same endpoint | `lanes.ts:63` |
| 30 | `deploymentEnv(framework, facts)` — hostname, path prefix, `FORCE_SCRIPT_NAME` | `framework-env.ts` |
| 31 | `configEnv` + shadowing warning when a name is in both config and `.env` | `:1739` |

### Deploying

| # | Capability | Where |
|---|---|---|
| 32 | `deployArgs` per lane; `existingScoped` for container sets | `lanes.ts:298, 274`; `liveContainerShape` at `deploy-pipeline.ts:312` |
| 33 | Release job — one-shot, before traffic moves, own Cloud Run job | `runRelease:2200` |
| 34 | `probeApp` with declared health, `strict`, `spaFallback` | `:742` |
| 35 | Siblings — extra services, **runner-only**, path-routed, own env/scale/health | `deploySibling:2355` |
| 36 | Sibling IAM-propagation retry loop (5×5s) | `:2469` |
| 37 | Processes — worker pools, cron jobs, release | `deployProcesses:398` |
| 38 | Serviceless (worker-only) — no service, no domain, no thumbnail | `:1728` |
| 39 | `SEAL_APPS` — two routing models (public + domain mapping / proxy-only) | `:2030` |
| 40 | Domain mapping create/remove; `clearStaleCloudSql` | `:2824–2846` |
| 41 | `assertReached` — did the revision come out holding what was asked for | `:2624` |

### Failing

| # | Capability | Where |
|---|---|---|
| 42 | `fetchContainerError` — the real crash log behind "didn't start on $PORT" | `:2641` |
| 43 | `classify(error)` → platform vs app blame; platform errors never reach the agent | `:2659` |
| 44 | Repair agent is **Pro-gated**; Basic gets a paste-ready `fixPrompt` | `:2669` |
| 45 | `opencodeRepair` / `repairDeploy` with a full redeploy callback | `:2693` |
| 46 | `snapshotSources` + `repairPatch` → `supersonic patch <app> \| git apply` | `:2691, 2721` |
| 47 | `StageRecorder` with lane, runtime, cold | `:1674` |
| 48 | `notifyDeployFinished` in `finally`, one place, every exit | `:2880` |

### The three facts that matter most

**The generated Dockerfile is a rare path.** Line 1596 gates it on
`runtimePinned && !existsSync(Dockerfile)` — it fires only when the repo pins a
version the runner cannot serve. The correct build path runs for almost nobody.

**Siblings are runner-only.** `deploySibling:2361` refuses any language that is
not node or python. Deleting the runner without replacing this path removes
multi-service apps entirely.

**Build-time secrets exist only inside the runner.** `runnerPrepareConfig`
(`build-config.ts:326`) is the only build config in the repo that emits
`secretEnv:` / `availableSecrets:`, and `grantBuildAccess` has exactly two call
sites, both inside runner prepare (`:2377`, `:2507`). `kanikoBuildConfig`,
`buildkitBuildConfig` and `cachedBuildConfig` take no secrets at all. The reason
this matters is already written down at `build-config.ts:350–357`: *"Prisma 7
evaluates `env('DATABASE_URL')` while loading prisma.config.js on EVERY cli
command, so `prisma generate` died on an app whose database the platform had
just provisioned."* Deleting the runner without porting this regresses the
largest language on the platform.

---

## Part 1 — The target

```
folder
  │
  ├─ detect() ───────────────── deterministic. version · package manager ·
  │                             install · build · start · framework · db · needs
  ▼
BuildSpec (one type, serializable, diffable)
  │
  ├─ nothing to run? ────────► GCS + pointer + shared static server   (unchanged)
  │
  └─ otherwise ──────────────► generated Dockerfile (or the repo's own)
                                    │
                               Cloud Build — dedicated per-build SA,
                               buildkit, layer cache, secret mounts
                                    │
                               Artifact Registry (scoped, GC'd)
                                    │
                        ┌───────────┼───────────┬──────────┐
                       web       sibling      worker     cron/release
                        │           │            │           │
                     service     service    worker-pool     job
```

Three rules:

- **A proper noun may select behavior; it may never supply a value the repo
  already answers.** Version, port, entrypoint, package list come from the repo
  or the user. Always.
- **Every decision is a hint with a fallback.** A wrong guess costs one retry.
- **Nothing is deleted before its replacement is green.** This is the rule the
  first draft broke in five places, and it is the reason the Order table below
  moves work earlier rather than adding it at the end.

---

## Part 2 — `lib/detect.ts`

New file, one export, deterministic, no model, no network.

```ts
export interface Toolchain {
  language: string;
  version?: string;
  versionFrom?: string;      // which file said so, or "platform default"
  packageManager: string;
  install?: string;
  build?: string;
  dir: string;               // "" = repo root. Everything is relative to this.
}

export interface BuildSpec {
  toolchains: Toolchain[];   // ordered; [0] is the one that serves
  language: string;          // = toolchains[0].language
  framework?: string;        // the token 2e matched on — deploymentEnv's only source
  command?: string;          // absent ⇒ static, or ask
  release?: string;          // the one-shot job's command
  outputDir?: string;        // set ⇒ nothing to run ⇒ static target
  database?: { engine: string; via: string };
  needs: string[];           // apt packages
  confidence: "certain" | "inferred" | "guessed";
}

export function detect(dir: string, config?: ServiceConfig): BuildSpec
```

**Why `toolchains[]` and not the flat shape.** Part 3 requires both toolchains in
one image — "or every FastAPI+React monorepo breaks." A flat
`packageManager`/`install` cannot hold two, and a repo root with both
`requirements.txt` and `pnpm-lock.yaml` would match 2b's first row and never
install the frontend. `dir` is equally load-bearing: every install/build/start
for a non-root service is wrapped by `inDir` today (`app-config.ts:705–709`,
`(cd ${dir} && ${cmd})`), and the generated Dockerfile has no notion of it.

**Why `framework`.** `deploymentEnv(s.framework, facts)` is on the Keep list and
is the only source of `ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`, `NEXTAUTH_URL`,
`RAILS_HOSTS` and `ROOT_PATH` (`framework-env.ts:55–96`). The file states the
consequence itself at `:59–60`: *"Django returns 400 on EVERY request when Host
is not in this list, which reads as the app being down."* 2e already identifies
Django by `manage.py` and Next by `next.config.*` — it just has to emit the
token it matched on.

**Why `database` and `release`.** See 2g and 2h. Both are today produced only by
the planner or a hand-written config, and Part 3 takes the planner off the
critical path.

### 2a. Version — rewrite `repo-runtime.ts`

`RepoRuntime.language` is typed `"python" | "node"` today (`repo-runtime.ts:40`)
and reads five files — which is why `generateDockerfile` is reachable only for
Python and Node at all: `deploy-pipeline.ts:1596` gates on `pinned`, and
`repoRuntime()` (`:72–89`) returns nothing else. Make it the universal path
unchanged and Go, Rust, Ruby, PHP and Java reach `baseImage()` with
`version: undefined`, which returns a bare repo name, which Docker resolves to
**`:latest`** — a runtime that moves under the customer with no deploy.

Three steps, in order: **read**, then **resolve**, then **validate**. The first
draft had only the first.

**Read.** `.tool-versions` first — one parser, all seven languages.

| File | Language | Status | Raw form → normalisation |
|---|---|---|---|
| `.tool-versions` | all | — | `python 3.12` / `nodejs 20.11.0`; map `nodejs`→node |
| `mise.toml` | all | — | `[tools]` |
| `.python-version` | python | have | verbatim |
| `runtime.txt` | python | have | strip `python-` prefix |
| `requires-python` | python | have | **range** — send to resolve |
| `.nvmrc` | node | have | strip leading `v`; `lts/*` → resolve |
| `engines.node` | node | have | **range** — send to resolve |
| `.node-version` | node | MISSING | strip leading `v` |
| `volta.node` | node | MISSING | exact |
| `go.mod` | go | MISSING | `go 1.23` exact; `toolchain go1.23.4` → **strip the `go` prefix** |
| `rust-toolchain.toml` | rust | MISSING | `channel` — `stable`/`nightly`/`nightly-DATE` are **not tags**; treat as "no pin" |
| `rust-toolchain` | rust | MISSING | same rule, bare file |
| `.ruby-version` | ruby | MISSING | verbatim |
| `Gemfile` | ruby | MISSING | `ruby "3.3.0"` exact; `~> 3.3` → resolve |
| `composer.json` | php | MISSING | `config.platform.php` **first** (concrete); `require.php` is a range → resolve |
| `.sdkmanrc` | java | MISSING | `java=21.0.2-tem` → strip vendor suffix, map to a Temurin tag |
| `pom.xml` | java | MISSING | `maven.compiler.release` / `java.version`; `1.8` → `8` |
| `build.gradle` | java | MISSING | `sourceCompatibility`; `JavaVersion.VERSION_17` → `17` |

The normalisation column is the part the first draft omitted, and it is where
the four new languages fail. `toolchain go1.23.4` produces `golang:go1.23.4`;
`channel = "stable"` produces `rust:stable`, a tag the official image does not
publish; `1.8` produces `eclipse-temurin:1.8`, which does not exist (the tag is
`8`); `.sdkmanrc`'s real values are `21.0.2-tem` while Temurin publishes
`21.0.2_13-jdk`.

**Resolve.** A range is not a tag. `repo-runtime.ts:41–47` states the current
contract — *"Verbatim, exactly as the repo wrote it. Never normalised."* — and
`deploy-pipeline.ts:1602` passes `pinned.spec` straight into `generateDockerfile`,
where `dockerfile.ts:105` interpolates it with no check. So
`requires-python = ">=3.11,<3.13"` already emits `FROM python:>=3.11,<3.13`.
Today that is invisible behind the `runtimePinned` gate; as the only path it is
a build failure for the majority of `requires-python`, `engines.node`,
`composer require.php` and `ruby "~> 3.3"` repos.

Resolve a range to the highest platform-known concrete tag satisfying it, and
record the choice: `versionFrom: "pyproject.toml >=3.11,<3.13 → 3.12"`.

**Validate.** `assertValidTag(version)` in `baseImage()`, refusing anything not
matching `[A-Za-z0-9_][A-Za-z0-9._-]{0,127}`. A malformed tag must fail in
`detect()` with a sentence naming the file, not at `docker build` with
`invalid reference format` — the repair classifier has no log to work with at
that point.

**When nothing declares a version**, pin an explicit one per language and set
`versionFrom: "platform default"`, which the config write-back records. `FROM
ruby` must never ship. Read first, choose only in silence, always record.

Pin the whole table with a fixture test of (file content → expected tag) cases,
including every row above. It is the cheapest test in the plan and it covers the
four languages with no fallback path.

`runnerServes` and `runtimeRouting` are deleted with the runner;
`repo-runtime.ts:1` imports `RUNTIME_VERSIONS`, so this file and step 4 land
together — but see Part 3's split delete table: the symbols leave the tree only
after decommission.

### 2b. Package manager → install

First match wins, most specific first — **applied per toolchain directory**, not
once over the repo root.

```
uv.lock              uv        pip install uv && uv sync --frozen --no-dev --no-install-project
poetry.lock          poetry    pip install poetry && poetry install --no-root --only main
Pipfile.lock         pipenv    pip install pipenv && pipenv install --deploy --system
requirements.txt     pip       pip install -r requirements.txt
pyproject.toml       pip       (see below — after COPY . .)
pnpm-lock.yaml       pnpm      corepack enable && pnpm install --frozen-lockfile
yarn.lock            yarn      corepack enable && yarn install --immutable
bun.lock / bun.lockb bun       bun install --frozen-lockfile
package-lock.json    npm       npm ci
package.json         npm       npm install
go.sum               go        go mod download
Cargo.lock           cargo     (build stage)
Gemfile.lock         bundler   bundle install --without development test
composer.lock        composer  composer install --no-dev --optimize-autoloader
```

Two corrections to the first draft:

**`uv sync` and `pip install .` build the local project**, and the cached layer
runs before the source is copied (`dockerfile.ts:171` copies manifests,
`:174` runs install, `:175` does `COPY . .`). `uv sync` needs
`--no-install-project` in the cached layer, with a project-only install after the
source copy. `pip install .` has no equivalent flag, so a pyproject-only Python
app installs *after* `COPY . .` and forgoes the cached layer — state that
explicitly rather than emitting a Dockerfile that cannot build. This is the
FastAPI template's exact shape (`infer-services.ts:188–191`).

**`bun.lock`** — bun ≥1.2 writes a text lockfile. Listing only `bun.lockb` drops
every modern bun repo to `npm install`.

Replaces `plan-deps.ts` and the LLM's `plan.install`.

### 2c. Build — from the manifest, never the framework

```
package.json has scripts.build   <pm> run build
go                               go build -o /app/server ./cmd/... || ./...
rust                             cargo build --release
everything else                  none
```

Next, Vite, Nuxt and Remix all have `scripts.build`. That is why per-framework
Dockerfiles were never necessary.

`go build -o /app/server ./...` fails on any module with more than one package —
`-o` with a directory pattern matching multiple mains is an error. Prefer the
module's declared main package; fall back to `./...` only when there is exactly
one.

### 2d. Start — ordered, first hit wins

```
1  Procfile web:                 lib/procfile.ts reads it today      certain
2  supersonic.json processes.web parsed today                        certain
3  --run / plan.run              CLI flag, already exists            certain
4  package.json scripts.start    <pm> start                          certain
5  FRAMEWORK_START               below                               inferred
─── detect() returns here ───────────────────────────────────────────────────
6  model, one string, repo in context                                guessed
7  ask the user one question                                         —
```

Rows 6 and 7 are **outside** `detect()`. The signature is synchronous with no
model and no network; a model call cannot live inside it. They belong to the
caller, which decides what to do with `confidence: "guessed"`.

**Whatever row wins, rewrite a literal port to `$PORT`.** `bindToPort`
(`infer-services.ts:131–138`) exists for exactly this and states why: *"every one
of the detector's Python start commands names a literal port — `uvicorn … --port
8000` … A container that binds the literal one never passes a health check."*
It moves into `detect.ts`; it does not get deleted.

Nothing found **and** an output directory of files exists → static target.

### 2e. `FRAMEWORK_START` — the entire proper-noun surface

17 rows. Third column: a server binary the command needs that the app will not
have declared, appended to `install`. Fourth column: the framework token, which
is `deploymentEnv`'s only input. This replaces `PYTHON_SERVERS` in
`plan-deps.ts` — derived from the row that caused it, not a global list.

```
signal                start                                         extra      token
next.config.*         next start -p $PORT                           —          next
nuxt.config.*         node .output/server/index.mjs                 —          nuxt
vite+react-router     react-router-serve ./build/server/index.js    —          remix
astro.config.*        node ./dist/server/entry.mjs                  —          astro
svelte.config.*       node build                                    —          svelte
manage.py             gunicorn {pkg}.wsgi:application -b :$PORT     gunicorn   django
main.py + fastapi     uvicorn main:app --host 0.0.0.0 --port $PORT  uvicorn    fastapi
app/main.py+fastapi   uvicorn app.main:app --host 0.0.0.0 …         uvicorn    fastapi
app.py + flask        gunicorn app:app -b :$PORT                    gunicorn   flask
wsgi.py               gunicorn wsgi:app -b :$PORT                   gunicorn   —
Gemfile + rails       bundle exec rails s -b 0.0.0.0 -p $PORT       —          rails
config.ru             bundle exec rackup -p $PORT -o 0.0.0.0        —          —
go.mod                /app/server                                   —          —
Cargo.toml            /app/target/release/{name}                    —          —
artisan               php artisan serve --host 0.0.0.0 --port $PORT —          laravel
index.php             php -S 0.0.0.0:$PORT                          —          —
Dockerfile (theirs)   —                                             —          (detector)
```

`{pkg}` = the directory containing `wsgi.py`. `{name}` = `package.name` in
`Cargo.toml`.

**Three rows are conditional, and the condition is not the config file.** The
detector already reads two of them — astro and next — and the first draft
dropped the check. The svelte condition is checked nowhere today and has to be
written: `deploy-agent/src/index.ts:155` sets `startCommand = "node build"`
unconditionally for `@sveltejs/kit` and never looks for an adapter.

- **astro** — `astroServe` (`deploy-agent/src/index.ts:85–89`) returns
  `{ mode: "static", outputDir: "dist" }` unless an adapter is configured. Its
  comment at `:80–84` explains why `output:` alone is not the signal. Without an
  adapter there is no `dist/server/entry.mjs` to run.
- **next** — `nextServe` (`:95–98`) returns static `out/` under
  `output: 'export'`. `next start` explicitly refuses to run against an exported
  build.
- **svelte** — `node build` requires `@sveltejs/adapter-node`.

A miss on the condition falls to the **static target**, not to row 6. Without
this, three classes of site that deploy correctly today on the lane Part 1 marks
"(unchanged)" get containerised around an entrypoint the build never emits.

The two **PHP rows are development servers.** `php -S` and `php artisan serve`
are single-threaded and serialise requests; Cloud Run's default concurrency is
80. They are acceptable as a first-deploy default only if the concurrency is
pinned to 1 for those rows, or they are replaced with `frankenphp` /
`php-fpm + nginx`. Decide which; do not ship `php -S` at concurrency 80 silently.

`Dockerfile (theirs)` yields no token of its own — the framework comes from the
detector or the config's `framework` field (`app-config.ts:114`).

### 2f. `needs` — apt packages

`dockerfile.ts` deliberately ships the **full** base image, not `-slim`, so
`psycopg2` and `Pillow` compile. That is true of the Python path; the Node path
is `node:22-slim` today. Making `generateDockerfile` universal therefore
increases the Node base image roughly fivefold — price it in Part 8's numbers
rather than describing it as continuity.

`needs` starts nearly empty and grows from real failures only:

```
node-canvas  libcairo2-dev libpango1.0-dev libjpeg-dev
mysqlclient  default-libmysqlclient-dev pkg-config
weasyprint   libpango-1.0-0 libpangoft2-1.0-0
```

### 2g. `database` — new

`s.database` has exactly two writers today: the detector subprocess, and
`deploy-pipeline.ts:1539` (`s.database = plan.needsDB ? … : s.database`) — the
planner, which Part 3 takes off the critical path. It is read at `:1793`
(`database: Boolean(s.database?.engine) || Boolean(appConfig?.resources?.database)`),
gates Postgres at `:1815`, and drives every one of `databaseEnv`'s 17 names, the
proxy sidecar, and the `proxyWait` Part 3 calls "Required".

The deterministic rule, from the detector's own logic
(`deploy-agent/src/index.ts:163–169, 214–218`):

```
package.json deps      prisma · drizzle-orm · mongoose · typeorm · sequelize · pg · mysql2
python deps            psycopg · psycopg2 · django · sqlalchemy · pymysql · pymongo · asyncpg
prisma/schema.prisma   datasource provider
Gemfile                pg · mysql2
go.mod                 lib/pq · pgx · go-sql-driver
```

**Or** state in one sentence that the detector subprocess stays on the critical
path purely for this, and name who owns it. What is not acceptable is the first
draft's position, where Part 1's diagram implies the detector is gone and
BuildSpec cannot carry what it produced. A Django repo that deploys today would
come up with no Cloud SQL instance, no `DATABASE_URL`, and no proxy.

### 2h. `release` — new

The one-shot migration command. Today `releaseCmd = releaseFromPlan(plan)`
(`deploy-pipeline.ts:1535`) is the only assignment, and `plan.preRun` comes from
`app-config.ts:731` for a written config or from the planner's own output. A
Procfile `release:` line is explicitly **not** executed — `:437` logs *"the
Procfile declares a 'release' process and it did NOT run"*.

```
1  supersonic.json release / preDeploy / processes.release   certain
2  Procfile release:                                          certain — newly honoured
3  manage.py present                                          python manage.py migrate
4  alembic.ini present                                        alembic upgrade head
5  prisma/schema.prisma present                               prisma migrate deploy
6  Gemfile + rails                                            bundle exec rails db:migrate
```

Without this, a config-less Django or Alembic app deploys **green against an
unmigrated schema** once the planner leaves the critical path. That is the worst
failure shape the platform has — a wrong success — and Part 5's classifier has no
row for it because there is nothing to classify.

---

## Part 3 — Collapse the routing, and replace what the runner did

```ts
export type Target = "static" | "container";
export type Build  = "dockerfile" | "generated";
```

`Target` is a **fact**: no start command and a directory of files → static.
Not a planner guess (`s.serve.mode` today). But it keeps today's `!hasDockerfile`
guard — a repo with a committed Dockerfile and a checked-in build directory is a
container, not a pile of static files.

`Build` is `hasDockerfile && !runCommandSupplied`. The second half is not
optional: `resolve.ts:139–147` documents why it exists — *"A repo Dockerfile
normally wins because the author was explicit — except when the deploying agent
has decided how to run this, which outranks a Dockerfile that may not even be
self-contained (an Nx `COPY dist/api` Dockerfile assumes a prior build)"* — and
`:202` implements it. `runCommandSupplied` is `Boolean(runCmd)` (`:1655`), and
`runCmd` has two sources: the `x-supersonic-run` header — the CLI's `--run`,
which Part 8 lists as untouched — and the planner's own `plan.run`, folded in at
`:1519`. Dropping it silently changes behaviour for exactly the monorepo shapes
that deploy today *because* of it, and for every planner-planned repo that also
ships a Dockerfile.

### The runner's twelve jobs, and where each goes

| Runner did | Now |
|---|---|
| No image build (the 40s) | Layer cache; cold is 2–4 min. Partly covered by URL-first — see Part 8, which is narrower than the first draft claimed. |
| Fetch encrypted code bundle at start | Code is in the image. **This is a weaker boundary, not an equal one — see Part 9.** |
| Warm wheelhouse / npm cache | Docker layer cache — exact deps, and it works for Go/Ruby/Java too. |
| Cross-deploy `node_modules` / `.next/cache` restore | **Not covered.** A layer cache does not survive a source change; the runner's restore did. Framework build caches (`.next/cache`) need a cache mount (`RUN --mount=type=cache`) or they are simply lost. |
| **Both toolchains in one image** | `BuildSpec.toolchains.length > 1` → template installs each, in its own `dir`. **Required, or every FastAPI+React monorepo breaks.** |
| **`wait_for_db` before exec** | `proxyWait()` (`release-job.ts:182`) prepended to `CMD` when `BuildSpec.database` is set. **Required, or Django/SQLAlchemy hit a startup race.** |
| **Build-time secret mount** | **Not covered by anything today.** `cachedBuildConfig` gains `secretEnv:`/`availableSecrets:`; `grantBuildAccess` moves out of the runner branch. Hard prerequisite — see below. |
| PATH: `.venv/bin`, `node_modules/.bin` | `ENV PATH=/app/.venv/bin:/app/node_modules/.bin:$PATH` |
| `.supersonic-prepared` marker | Gone — build happens at build time. |
| Fallback install at container start | Gone. |
| Next.js default start | `FRAMEWORK_START`. |
| `HUSKY=0` in the prepare env | Must be set in the Dockerfile. `.dockerignore` removes `.git`, which is exactly when the near-universal `"prepare": "husky"` hook exits 127 and fails `npm ci`. |

`proxyWait()` is already used for workers, crons and release jobs, and probes
`nc`, then `python3`, then `node`. **It is not language-agnostic in the images
this plan adds** — a Go, Rust or Java base image has none of the three, and the
function degrades to an unconditional 30-second sleep on every container start.
Either add one probe that always exists (a `/dev/tcp` bash redirect, or a tiny
static binary copied into the image) or restrict the CMD prefix to images known
to carry a probe. A silent 30s cold-start penalty on every Go app is not
acceptable.

### Build-time secrets — the prerequisite

`runnerPrepareConfig` (`build-config.ts:326`, secret block at `:358–374`) is the
only build config that mounts secrets. `kanikoBuildConfig(image, slug)` (`:85`),
`buildkitBuildConfig(image, daemonImage, slug)` (`:172`) and
`cachedBuildConfig(image, builder, slug)` (`:209`) take none, and the container
path at `deploy-pipeline.ts:2122` never calls `grantBuildAccess`.

Work, before anything is deleted:

1. `secretEnv?` / `availableSecrets` parameters on all three builder configs.
2. `grantBuildAccess(secretRefs, BUILD_SA, log)` called from the render/build
   stage, not the runner branch.
3. Keep `buildSecrets` (`:1973`) — the filter deciding which secrets a build may
   see. Rename it if `SUPERSONIC_CODE_KEY` is gone; do not delete it.
4. Thread `buildEnv` as `ARG`/`--build-arg`. It is parsed
   (`app-config.ts:570`), resolved (`resolve.ts:338`), printed by `check`
   (`check.js:199`) and asked about by `init` (`draft.js:430–436`) — and read by
   no build path. Making the container lane universal is the moment to either
   wire it or delete it from the schema. Leaving it accepted-and-ignored is
   documented case #6 of the defect the Rules section forbids.

One day, and it blocks step 4. Note the layer-baking hazard in Part 9 before
choosing `--build-arg` for anything secret.

### Siblings — the biggest hidden dependency

`deploySibling:2361` refuses anything that is not node or python, because a
sibling is always a runner bundle. With the runner gone, a sibling becomes an
ordinary generated image. This is strictly better — a sibling can be Go — but the
first draft's one paragraph hides five concrete pieces of plumbing, none of which
exists:

| Needed | Today |
|---|---|
| Per-service image name | One `${IMAGE}` = `…/cloud-run-source-deploy/${slug}` (`:2104`) |
| Per-service Dockerfile filename | Hardcoded `--dockerfile=Dockerfile` (`build-config.ts:90`) and `-f Dockerfile` (`:178`) |
| Per-service cache repo | `${image}-cache` (`:93`, `:173`) — two siblings would share and overwrite |
| Build context rooted at `svc.dir` | `WORKDIR /app` + `COPY . .` from the build root (`dockerfile.ts:167–175`) |
| Its own `cloudbuild.yaml` path | Siblings write to `join(dir, "cloudbuild.yaml")` (`:2378`) — the same path the primary uses |

The sibling loop is serial and awaited (`:2764–2773`), and each `builds submit`
sends the whole repo (`:2385`). It is already serial today, so the change is
per-build duration, not concurrency: a 4-service repo goes from 4 sequential
prepares to 4 sequential full image builds — 8–16 minutes at the plan's own cold
figure. Either parallelise the loop or put an honest number in Part 8.

It keeps its own env, scale, health, `pathPrefix` and `deploymentEnv` exactly as
today — which is another reason `BuildSpec.framework` has to exist, since a
path-prefixed Next sibling renders blank without `NEXT_PUBLIC_BASE_PATH`.

### Delete — in step 4 (the collapse)

| What | Where |
|---|---|
| `laneFor`, `deriveLane`, `RUNNER_RUNTIMES`, `LANE_CONSUMES` — **behind the flag, bodies kept** | `resolve.ts:183,217,114,230` |
| `spaDockerfile`, `nextDockerfile`, `isNextApp` | `deploy-pipeline.ts:934,961,985` |
| `BASE_IMAGE_BINS`, `PYTHON_SERVERS`, `ensureRunDeps` | `plan-deps.ts:23,38`, `:859` |
| buildpack lane — every `run deploy --source` and `builds submit --pack` | `:2585, 2571` |
| `planDeploy` **from the critical path** — module stays, repair-only | `:1468` |

### Delete — only after decommission (the query in "The one real risk" returns empty)

| What | Where |
|---|---|
| `RUNTIME_VERSIONS` (three copies + `services/deploy-agent`) | `plan-deps.ts:191`, `vendor/detector.js:38`, `resolve.js:649` |
| `runnerServes`, `runtimeRouting` | `repo-runtime.ts:116,166` |
| `services/runner/` — 2 Dockerfiles, `entrypoint.sh`, `prepare.sh`, `build.sh`, both popular-*.txt | whole dir |
| `runnerPrepareConfig` | `build-config.ts:326` |
| `SUPERSONIC_CODE_*`, `SUPERSONIC_CODE_KEY` minting | `:1956, 1990` |

The split is the whole point. `services/runner/build.sh` is the only thing that
builds `runner-node:latest` / `runner-python:latest`, and every live runner
revision cold-starts from those images. Deleting the directory while apps still
run on it means those images can never be patched.

### Do not delete — corrections to the first draft

| First draft said delete | Why it stays |
|---|---|
| `stripQualityGates` (`build-gates.ts:28`, called `:1694`) | Its only call site is inside the **static branch**, which Part 1 marks "(unchanged)". Deleting it makes every static app whose build script starts with `tsc`/`eslint`/`vitest` start failing on the deploy that ships this. Delete it in its own change, with its own decision. |
| `bindToPort`, `PYTHON_ENTRIES`, `PYTHON_RUNNABLE`, `pythonModule`, `pythonInstall` (`infer-services.ts`) | `inferAppConfig` is on the Keep list and is built entirely out of them: `inferAppConfig:264` → `deployableParts:275` → `isDeployablePart:245` → `PYTHON_RUNNABLE:127`; `serviceFor:299` → `pythonInstall:216` + `startFor:224` → `bindToPort:164` + `pythonModule:166`. They **move into `detect.ts`** and `serviceFor`/`isDeployablePart` rewire onto `detect()` — which is what Part 3's per-service `detect()` rooted at `svc.dir` implies. This is step 1 work, not step 4. |
| `buildSecrets` (`:1973`) | The only thing that computes which secrets a build may see. See above. |

### Keep — and what each one costs

Free, genuinely untouched: `publishPrebuilt` / `--prebuilt` · `runStatic` and the
GCS pointer · `planResources` · `provisionPostgres` and the per-app role ·
external database · `provisionStorage` · Secret Manager · `mergeDatabaseEnv` ·
`databaseEnv`'s 17 names · `configEnv` shadow warning · release job ·
`deployProcesses` · `SEAL_APPS` · domain mapping · `clearStaleCloudSql` ·
`assertReached` · `fetchContainerError` · Pro gating · `notifyDeployFinished` ·
clone reuse · `pruneBrokenSymlinks` · sibling IAM retry.

Kept, but **not free**:

| Kept | What it needs |
|---|---|
| `deploymentEnv` | `BuildSpec.framework`. No token, no `ALLOWED_HOSTS`. |
| `inferAppConfig` | Rewire onto `detect()` per directory (above). Step 1. |
| `refusalReason` | A new trigger. Its only call site (`:1628`) is gated on `plannerFailed`, assigned in exactly one place — the planner's `catch` at `:1557`. With the planner off the critical path it is dead code. Replace with `confidence === "guessed" && declaredLanguages(facts).length > 1 && !hasDockerfile`. `repo-facts.ts:172–177` states the contract, and `:150–156` names the repo it was written for. |
| `existingScoped` / `liveContainerShape` | Their fallback is `d.lane === "runner"`. Removing `Lane` removes the default that protects every live runner service during the migration deploy. Re-express against `Build`. |
| Serviceless (worker-only) | It has no builder left — the plan deletes `builds submit --pack`, its only one — and `generateDockerfile` **throws** without a command (`dockerfile.ts:158`). Give it the same generated image with the worker's command as `CMD`, or say it keeps a builder. |
| `probeApp` | Cold start moves from a warm shared base to a per-app image. Re-check the timeouts in `verify-app.ts:86–112` (4 attempts, 20s, 2/4/8s backoff) against a first pull of a ~1 GB image. |
| `classify` | Two of its rules pre-empt Part 5's table. See Part 5. |
| `repairPatch` | It already diffs the generated Dockerfile, and that is the bug. See Part 5. |

### Four build-execution fixes

**1. The manifest `COPY` — before the deletion, not after.**
`dockerfile.ts:140–145` defines `MANIFESTS` as 20 bare filenames and `:171`
emits them as one `COPY package.json* … mix.lock* ./`. Two failures:

- **Zero matches is a hard build failure**, not a skip. The comment at `:138–139`
  claims *"a repo that has none simply skips the step"* — that is not how `COPY`
  behaves. `pom.xml`, `build.gradle*`, `*.csproj`, `bun.lock`,
  `pnpm-workspace.yaml` and `.npmrc` are all absent from the list, so Maven,
  Gradle, .NET and a bare-`index.php` app die on line 6 of every generated
  Dockerfile. Part 8's *"now covers Go, Ruby, Java and PHP"* is false for Java
  out of the box.
- **The globs are root-relative.** `backend/requirements.txt` and
  `frontend/package.json` are not copied, so `RUN (cd frontend && npm ci)` runs
  against a WORKDIR holding only root manifests. `build-config.ts:340–343`
  already records this for the runner: *"a monorepo matches none of its cases."*

Fix: build the `COPY` list from the manifests actually on disk
(`repo-facts.ts:93–133` already returns each declaration's relative path), emit
path-preserving `COPY`s, skip the instruction when the list is empty, and fall
back to `COPY . .` before install when a path cannot be resolved — accept the
cache bust rather than emit a Dockerfile that cannot build. Add a test that
generates **and builds** for a manifest-less repo.

**2. Default to buildkit — in three steps, not one.** `selectedBuilder`
(`build-config.ts:23`) returns kaniko unless `BUILDER=buildkit`. Google archived
kaniko 2025-06-03 and the file's own comment says buildkit caches strictly more.
But `build-config.ts:149–163` also records that `BUILDKIT_IMAGE` is unset by
default, *"which means buildx's own `moby/buildkit:buildx-stable-1` — a Docker
Hub pull on the critical path of every container build"*, and `docs/CUTOVER.md`
has already sequenced this:

- `:355–364` — a captured run showing `pulling image moby/buildkit:buildx-stable-1 15.1s`
- `:366–367` — *"Mirror the image into AR and set this **before** turning
  `BUILDER=buildkit` on for real traffic."*
- `:369–378` — *"Registry auth for `--push` is unverified … If any fails, every
  Dockerfile deploy fails with `denied` … total failure of the lane, not a
  degraded cache. Kaniko authenticated itself. Test this on one app before any
  wider rollout."*

So: (a) mirror the base images **and** `moby/buildkit` into AR, set
`BUILDKIT_IMAGE`; (b) canary `BUILDER=buildkit` on one app and confirm `--push`
and both cache endpoints authenticate; (c) flip the default. Flipping first
doubles Docker Hub exposure per build on the lane the mirror exists to protect,
at the moment it becomes the only lane.

**3. Mirror base images, and pin by digest.** Every `FROM python:3.12` is an
anonymous Docker Hub pull from a shared GCP NAT range. Invisible now,
intermittent build failures at launch volume, and they look like broken apps so
healthy deploys reach the repair agent over a rate limit. A remote repository
proxying Docker Hub, with `OFFICIAL` (`dockerfile.ts:64`) pointing at it — noting
that not every entry is on Docker Hub (`mcr.microsoft.com/dotnet/sdk` is not), so
the mapping is per-entry, not a prefix swap.

Then resolve the tag to a **digest** at render time and emit
`FROM python@sha256:…`. `baseImage()` emits a moving tag today, which reproduces
one level up the exact `:latest` defect 2a exists to fix, and makes Part 6's
byte-identical-reuse claim impossible across a base refresh. Record the digest in
the config write-back next to `versionFrom`.

**4. A dedicated build service account.** See Part 9. It belongs in this list;
it is sized there because it travels with the registry work.

---

## Part 4 — Stage the pipeline

`runDeploy` is `:1232–2883`. Eight stages, each typed, each recording to
`deploy_stages`:

```
resolve    config + detect() → BuildSpec
provision  planResources, db, bucket, secrets → env
render     Dockerfile + .dockerignore into the build copy
build      cachedBuildConfig → Artifact Registry
release    the one-shot job, before traffic moves
deploy     service / siblings / worker pools / cron jobs
verify     probeApp
finalize   domain, config write-back, thumbnail, notify
```

`runDeploy` becomes a ~60-line loop. Stages take explicit inputs — no reaching
back into `gcloud describe` to rediscover what an earlier stage did.
`liveEnvNames`, `liveContainerImage` and `liveContainerShape` exist because it
currently does.

Every failure carries its stage name, which is what Part 5 needs.

### The stage names are an API, not labels

`deploy_stages` has consumers that hardcode every name, and renaming stages
without them blinds the only instrument that can measure this migration:

- `LANE_BLIND_STAGES` (`analytics/attempts.ts:58–66`) names the seven pre-lane
  stages by string.
- `ATTEMPT_START_STAGE = "run-record"` (`:69`) is what splits rows into deploys
  at all.
- `lane = s.lane` is taken from the **last** non-blind stage (`:219–222` — the
  loop has no `break`, so each non-blind row overwrites the previous).
- The activation metric is
  `min(ended_at) FILTER (WHERE stage = 'deploy' AND outcome = 'ok')`
  (`analytics/queries.ts:322`).
- The reliability table groups by
  `KNOWN_LANES = ["static","runner","container","buildpack"]`
  (`analytics/report.ts:276`).

Today's emitted stages are `clone`, `detect`, `infer-services`, `unpack`,
`release`, `build`, `upload`, `verify`, `prepare`, `deploy`, `repair-agent`,
`processes`. The eight above keep four of them, drop eight, and add four names
nothing knows.

So, in the same work item: keep `clone`, `detect` and `repair-agent` as stages
(`repair-agent` is the only timing on the loop Part 5 promotes to primary); write
the old→new mapping into `attempts.ts`; decide what `lane` holds after the
collapse (`"container" | "static"` is enough) rather than leaving a constant; and
record `versionFrom` and the build's cold/warm-cache outcome. `deploy_stages`
already has `runtime` and `cold` columns (`stages.ts:47–52`), so this needs no
migration and does not violate the no-new-schema rule.

`stages.ts`'s own header (`:14–16`) records that this class of mismatch has
shipped once before: *"`deploy_stages` has been collecting data since 004 while
the question it was created to answer could not be computed from it."*

---

## Part 5 — Repair as the primary mechanism

Runs on failure only, max 3, then ask. `classify` (`:2659`) already separates
platform blame from app blame — but it needs two changes before it can carry
this, and the first draft's "keep it" is wrong.

### Fix `classify` first

**It matches over the whole build log.** Build failures return a blob:
`:2546` returns `Build failed:\n${buildLog}`, up to 40 lines (`:910`) selected by
a `keep` regex that deliberately retains lines containing "denied", "not found",
"unsupported", "invalid" (`:903`). `classify` (`deploy-errors.ts:114–134`) then
runs its platform regexes against that entire blob — `:38` fires on
`permission denied|forbidden|\b403\b`, `:42` on `quota|rate limit`. One
`EACCES: permission denied, mkdir '/root/.npm'` anywhere in an otherwise
app-caused failure makes the whole deploy "platform" and returns at `:2660–2666`
before the Pro gate and before repair. With build-time failures now dominant,
this withholds the dominant failure mode from the mechanism Part 5 makes
primary — and it is invisible, because `attempts.ts:242` records `repair: "none"`,
indistinguishable from a deploy that never needed one.

Fix: Part 4 gives every failure its stage name. Match platform patterns against
the terminal error line and the failing stage, not an embedded log body.

**Two rules pre-empt this table's own rows.**

- `deploy-errors.ts:59` — `could not connect|connection refused|econnrefused…`
  → platform, *"That is infrastructure, not your app."* That is precisely the
  failure Part 3 newly introduces by moving `proxyWait` onto the web CMD. The
  most valuable row below is dead on arrival. Narrow it: a loopback refusal
  (`127.0.0.1:5432`) after `proxyWait` is a startup-order fact the repair loop
  can act on.
- `deploy-errors.ts:46` — `requires a different python|requires-python` →
  platform, *"This app needs a language version the platform does not run yet.
  No edit to your repository can change that."* That sentence is false the moment
  `FROM python:3.14` is buildable, and pip prints `requires a different Python`
  straight into the build log — hiding a one-line `FROM` correction from repair.

Require every platform rule to name the stage it is valid in.

### Then classify which repair

```
ModuleNotFoundError / ImportError          add the dep, or a system package
Cannot find module 'X'                     same, npm side
gcc: not found · fatal error: *.h          add to `needs`
pg_config not found                        add to `needs`
exec format · not found: <cmd>             wrong start command → next row of 2d
container exited 0 immediately             wrong start command
container up, port never opened            not binding $PORT → bindToPort
could not connect to 127.0.0.1:5432        missing proxyWait (see narrowing above)
invalid reference format · manifest unknown  bad version tag → 2a resolve
no source files were specified             manifest COPY matched nothing
build timeout                              layer ordering
unmatched                                  model, free-form, with build log + tree
```

**The model patches the Dockerfile; it does not author one.** Adding one
`RUN apt-get install -y libpq-dev` because the log said `pg_config not found` is
easy and verifiable; generating a Dockerfile from blank is neither.

### The patch channel is broken today

Part 5's first draft said `repairPatch` *"is already this shape — point it at the
Dockerfile as well as the app."* It is already pointed there, and that is the
defect:

`repair-diff.ts:66` is `git diff -- .` over the whole scratch dir — every tracked
file, by construction. Its baseline, `snapshotSources(dir)` at
`deploy-pipeline.ts:2691`, runs **after** the pipeline has written
platform-owned files into that same dir: `Dockerfile` and `.dockerignore` at
`:1600, :1607`, `cloudbuild.yaml` at `:2122`. So any agent edit to the Dockerfile
emits a normal `--- a/Dockerfile` modification hunk. The user's repo has no
Dockerfile (`dockerfile.ts:157`: *"Written into OUR copy of the repo, never the
author's"*), and `git apply` validates every hunk before applying any — so the
whole patch aborts, taking the one-line `requirements.txt` fix with it. The
failing-deploy email advertises that exact command, as does `:2728`.

This is already reproducible on the SPA/Next path (`:1707, :1710` write a
Dockerfile pre-snapshot). The plan makes it the default for every app.

Fix, two parts:

- Give `repairPatch` an explicit pathspec:
  `git diff -- . ':(exclude)Dockerfile' ':(exclude).dockerignore' ':(exclude)cloudbuild.yaml'`.
  App-level fixes keep working and stay appliable.
- Deliver the Dockerfile delta through a different channel — a `needs` / `build`
  block written into `supersonic.json` via Part 6's write-back, or a
  `supersonic dockerfile <app>` dump. Never through `git apply`.

**Persist the repaired Dockerfile.** It lives only in the scratch dir today, so a
"fixed" app regenerates the identical broken Dockerfile and pays the full repair
loop on **every** deploy. Whatever channel is chosen above has to feed back into
render, or the fix never sticks.

**Rerender on repair.** The redeploy callback starts at `builds submit`, not at
render — so the deterministic rows above (a corrected start command, a corrected
version tag) have no executor. The callback moves to the top of the `render`
stage.

### The wall-clock budget

`MAX_REDEPLOYS = 3` (`agent.ts:132`, `opencode-deploy.ts:63`), so a failing first
deploy is **four** full builds plus four probes (`verify-app.ts:86–112`: 4
attempts, 20s timeout, 2/4/8s backoff ≈ 95s each). At 2–4 min per cold build
that is 15–25 minutes worst case — less in practice, since repair rebuilds hit a
warm layer cache unless the repair changed a manifest.

The deploy itself survives that: production sets `DEPLOY_JOB=1`
(`cloudbuild.yaml:85`), so the pipeline runs in a Cloud Run Job with
`--task-timeout 60m` (`setup-deploy-job.sh`). What does not survive:

- the narration stream (Cloud Run's default 300s request timeout);
- the CLI, which polls only 180s after the stream ends
  (`index.js:872 followDeployOnServer(slug, ms = 180000)`) and then `die()`s at
  `:948`;
- **the tunnel** — `die` exits the process and `index.js:670–673` registers
  `process.on("exit", cleanup)`, which closes the tunnel WebSocket and kills the
  dev server.

So at roughly 8 minutes — 300s of stream plus 180s of polling — the live preview
goes dark **while the repair is still building** — the mitigation evaporates in exactly the case it exists for, and the
user is told contact was lost while three more builds run. Also
`opencode-deploy.ts:286` uses `curl --max-time 1200`, the same number as
`BUILD_TIMEOUT` (`build-config.ts:56`), so a build using its full allowance
returns `DEPLOY_FAIL:` with an empty reason.

Fix: publish the four-build budget; cap total repair wall clock, not just attempt
count; raise the CLI's poll window and decouple tunnel lifetime from the deploy
call exiting; make `--max-time` strictly larger than `BUILD_TIMEOUT`.

Pro gating (`limits.autoFix`) and the `fixPrompt` path for Basic stay exactly as
they are.

**Promote.** Log every repair with its classification. Same repair on 3+
different apps → it becomes a row in a Part 2 table and the model stops being
asked. That is how the tables grow: from failures, not from guessing. This needs
one column on an existing table — `deploy_stages` already carries the stage and
outcome; the classification is the new value. Say so, rather than leaving it as
an unbudgeted "we will log it."

---

## Part 6 — Determinism

**Cache the winning Dockerfile** on
`hash(lockfiles + BuildSpec + needs + hasDatabase + baseDigest + TEMPLATE_VERSION)`.
The first draft's `hash(lockfiles + BuildSpec)` cannot hold what Part 3 puts in
the Dockerfile:

- `proxyWait` in `CMD` depends on whether a database was provisioned — a
  provisioning fact from `planResources`, now carried as `BuildSpec.database`.
- `needs` grows from repairs, so it is not derivable from the lockfiles.
- The base **digest** (build-execution fix 3) is what makes reuse actually
  byte-identical.
- Without `TEMPLATE_VERSION`, every generator change — adding `proxyWait`, the
  PATH line, the manifest-COPY rewrite — silently never reaches any app whose key
  is already cached. That is the failure that matters most, because it looks like
  the fix shipped.

**State the cache's tenancy.** The nearest precedent in the repo is deliberately
cross-tenant: `plan-cache.ts:19–21` — *"Keyed by content rather than by slug, so
the second deploy of an unchanged repo is free AND so is the first deploy of a
repo somebody forked."* That is correct for a deterministically generated
artifact and wrong for one an LLM patched. Scope repair-produced entries to the
app; share only generated ones.

**Write `supersonic.json` back on green** — every decision, marked
decided-by-us vs declared-by-you, including `versionFrom: "platform default"` and
the resolved base digest. A lockfile, not a form. First deploy on a bare folder
still requires nothing.

Two constraints the first draft did not resolve:

- **The Rules section forbids new schema fields until deploys work.** Write-back
  markers are new fields. Either grant this one explicit exception and say so, or
  write the markers as a comment block / sidecar (`supersonic.lock.json`) that
  `parseAppConfig` need not learn. Do not add fields that `parseAppConfig`'s
  fixed key list would silently drop — that is the exact defect the rule cites.
- **The channel.** The server has a clone, not the user's working tree. Write-back
  is straightforward for the upload path (the CLI has the folder) and is not
  defined for `--github` / git deploys. State that write-back is upload-path only,
  or add a PR-opening step and cost it.

This inverts `supersonic init`, which today writes "a DRAFT for an agent to
correct." Keep `init` as an explicit command; stop it being the recommended first
step.

---

## Part 7 — Ship surface

- **Auto-rollback.** `supersonic rollback` exists as a manual command. Make it
  automatic on crashloop or a 5xx spike: shift traffic to last-green, notify.
  This is what makes "no operator" credible. **What does not exist**: any metrics
  source, threshold, scheduler or watcher. This is not "make the manual command
  automatic", it is building the trigger. Also: rollback cannot cover static apps
  (no Cloud Run service), and during the migration it moves traffic to a revision
  built by a mechanism the next deploy can no longer reproduce — say what
  rollback means across the cutover.
- **Watch → fix-prompt.** Prod error → diagnosis + patch to the user's own agent.
  `/api/apps/[slug]/diagnose` and `/fix` already exist — **for public,
  git-deployed container apps only.** Both return 400 without `svc.repo`
  (`diagnose/route.ts:59–60`, `fix/route.ts:32–36`), which is set only when the
  deploy had a git URL (`deploy-pipeline.ts:1735`), and both `git clone` with no
  credentials (`:64`). The default deploy is a folder upload from the user's
  machine. Static apps have no service to describe. And `diagnoseError`
  (`agent.ts:200`) returns a fix-**prompt**; nothing on this path produces a
  patch. Real work: source-less diagnosis (the deploy already calls
  `snapshotSources`, but nothing persists it), private-repo auth, prompt→patch.
- **Backups + restore.** Does not exist in any form.

---

## Part 8 — What the user sees

**Cold builds go from 40s to 2–4 min on Node and Python** — for the apps the
runner can serve today. Anything pinning a version other than the runner's two is
already on buildpacks, where the generated Dockerfile is a **speed-up**. Measure
the split before quoting the regression as universal.

The first draft called this "already mitigated" by URL-first deploy — a live URL
in ~0.1s, tunnelled to the local dev server while the real build runs behind it.
**The mitigation is narrower than that.** The tunnel comes up only with an
explicit `--dev-cmd`/`--dev-port`, or a Node `package.json` `dev` script. So it
does not cover:

- Python — and every language this plan adds;
- `--github` and CI deploys, where there is no local dev server at all;
- a failing deploy past ~8 minutes, when the CLI exits and `cleanup` closes the
  tunnel (Part 5).

Two of those three are fixable and neither is free. **Do not touch the tunnel,
the proxy or `--dev-cmd` during any of this work** — they stop being a nicety and
become load-bearing. Extending the tunnel to Python (`uvicorn --reload`,
`manage.py runserver`) is the single highest-leverage UX row in the table and it
is not currently in it.

Redeploys with an unchanged lockfile stay fast via layer cache — and unlike the
runner, that now covers Go, Ruby, Java and PHP. But a layer cache is not what the
runner had: the runner restored `node_modules` and `.next/cache` **across**
deploys, which survives a source change; a layer cache does not. Framework build
caches need `RUN --mount=type=cache` or they are lost.

**`supersonic check` needs rewriting, and it breaks the moment the collapse
lands.** `packages/cli/src/resolver.entry.ts` is a bundle manifest that
re-exports `deriveLane` (`:28`), `bindToPort, pythonInstall, pythonModule`
(`:37`) and `RUNTIME_VERSIONS, runtimeMismatch, RUNTIME_UNSUPPORTED` (`:47`) —
the middle group touched by step 1 (the `detect.ts` move), the other two by step
4. `check.js:98` calls `runtimeMismatch`, and `:155/:161/:173` read `s.lane`.
`package.json` runs `prepublishOnly: bundle && test`. So the CLI stops bundling
and publishing the day step 4 lands — which is why the `check` rewrite is booked
into that same row. Land it **with** step 4, or ship no-op shims in the same
commit. (The committed `vendor/resolve.js` keeps already-installed CLIs working,
so this is a build/publish break, not a user-facing outage.)

Note also that `vendor/resolve.js` and `vendor/detector.js` are esbuild output
that nobody edits — the work is on `resolver.entry.ts` and the libs it pulls in,
not on the vendored files.

**Fix the stamp manifest first.** `packages/cli/scripts/stamp.mjs:26–42` lists
`BUNDLES["resolve.js"]` as seven files and **omits `repo-runtime.ts`** — the exact
file Part 2a rewrites — as well as `procfile.ts`, `processes.ts` and
`process-plan.ts`, all of which esbuild inlines transitively. `test/vendor.test.js`
compares stamps (`:28`) and otherwise only checks that the bundle still exports
the expected names (`:39`) and that the detector's Python matches
`RUNTIME_VERSIONS` (`:56`) — nothing in it reaches `repo-runtime.ts`, so
rewriting that file leaves the stamp unchanged and the test green on a bundle
built from the old two-language rules.
`stamp.mjs:11–17` records that this exact failure has already happened once. One
line, day one of step 1 — better, derive the list from esbuild's metafile so it
cannot drift again.

With one path, "which lane" is meaningless; `check` becomes "here is the
Dockerfile we would generate, here is the start command and which file it came
from." Also drop its `runtimeMismatch` gate — it exits 1 on runtimes the deploy
already builds fine, and a Dockerfile-per-version design makes that divergence
strictly worse.

Untouched: `--prebuilt`, `--run`, `--github`, `--dev-cmd`, `logs`, `diagnose`,
`patch`, `rollback`, `apps`, `open`, billing, auth, domains.

---

## Part 9 — Isolation and lifecycle

None of this was in the first draft. All of it becomes load-bearing the moment
every app builds an image.

### Build identity

`gcloud builds submit` is called at five sites (`:2283, 2385, 2512, 2539, 2571`)
with **no `--service-account`**. `BUILD_SA` defaults to the project's default
compute account (`deploy-pipeline.ts:74`, comment at `:67–73`). The danger of
that identity is already written down 2,000 lines later, about the *runtime*
container (`:2033–2041`): *"the project's default compute service account …
carries run.admin, storage.admin and artifactregistry.writer. That gives every
customer's code — arbitrary code we agreed to run — the ability to delete the
control plane, read every other customer's source out of the build bucket, and
overwrite another app's image."*

`RUN <install>` is customer code. `npm ci` runs `postinstall`; 2f adds `apt-get`
as an expected RUN. Today that reaches Cloud Build on the runner prepare, the
buildpack lane and static; after step 4 it is the single path for 100% of apps.
And `grantBuildAccess` (`app-secrets.ts:138–148`) grants
`secretmanager.secretAccessor` to that same shared account — so once build
secrets are restored (Part 3), every app's build can read every app's secrets.

**Work:** a dedicated per-build service account with `artifactregistry.writer`
scoped to the app's own package and `secretmanager.secretAccessor` scoped to the
app's own secrets, passed as `--service-account` on every `builds submit`. It is
the same argument as `APP_RUNTIME_SA`, applied to the half of the pipeline that
now runs the customer's code.

### The isolation claim

The first draft's runner-jobs table said *"Per-image Artifact Registry IAM
replaces per-bundle AES."* There is no per-image IAM — Artifact Registry grants
at repository level, and `:2104` puts every tenant's image in one repository,
`cloud-run-source-deploy`. What is being deleted is a per-deploy random AES key
held only by that app (`:1956–1959`, `services/runner/entrypoint.sh:26–31`).

This widens an existing exposure rather than creating one — container- and
buildpack-lane apps already push to that repo and already run as the default
compute account — but the sentence asserts an equivalence that does not exist.
Replace it with the real work: one repository per app (or per workspace) with a
scoped reader binding, or a non-empty `APP_RUNTIME_SA` granted reader only on its
own repo.

### Registry lifecycle

Nothing ever deletes an image. `deleteApp` (`gcloud.ts:384–429`) is the app's only
teardown path; its docstring claims it removes *"everything a deploy of it
created"* and it enumerates eleven things — service, siblings, domain mapping,
bucket, static release prefix, `ready/<slug>`, `cache/<slug>.tgz`, thumbnail,
Postgres, secrets, in-flight deploys — and never touches Artifact Registry. There
is no `gcloud artifacts` call anywhere in `apps/web/lib`, and
`infra/terraform/README.md` says the IaC layer is *"Not yet implemented."*

Today only a Dockerfile repo reaches this path, so the leak is invisible. After
step 4 every app pushes a full base image plus a `mode=max` cache — which by
construction holds *more* layers than the image — on every deploy, and each
repair retry pushes another. Storage grows with **deploys**, not apps, and a
deleted app's complete source stays readable forever.

**Work:** extend `deleteApp` to delete the `<slug>` and `<slug>-cache` packages;
declare a retention rule for live apps (keep N tagged versions + untagged
cleanup). State explicitly that the policy must not delete digests still
referenced by a Cloud Run revision, or rollback breaks — and that the runner base
images are exempt until decommission.

### Slug reuse

`randomSlug()` is one letter plus four alphanumerics (`slug.ts:16–21`), and
`resolveSlug` builds its `taken` set from `serviceList()` — the *currently live*
services (`gcloud.ts:190–203`). A slug freed by `deleteApp` is immediately
re-issuable. `gcloud.ts:377–379` already states the consequence in the code:
*"the slug space is five characters, so a name WILL eventually be reused, and the
new app would have inherited a stranger's tables"* — which is why the database
delete was added.

The image path derives from the same slug and is **not** deleted. So a new tenant
inherits `<slug>:latest` and, more sharply, `<slug>-cache`, which buildkit reads
via `--cache-from type=registry` (`build-config.ts:177`) before it builds
anything. If the new tenant's build fails before pushing,
`gcloud run deploy --image <slug>:latest` has a stranger's image under the tag.

**Work:** delete both packages in `deleteApp`, make `resolveSlug` check Artifact
Registry as well as Cloud Run, or scope the image name
(`<workspace>/<slug>`).

### Layer-baked build secrets

Whatever mechanism restores build-time secrets (Part 3) lands in a
customer-visible Dockerfile whose intermediate layers are exported to a `mode=max`
registry cache and whose image is never deleted. `--build-arg` values are visible
in image history. Use Cloud Build's `availableSecrets` + `secretEnv` (which is
what `runnerPrepareConfig` already does) or buildkit `--mount=type=secret`, never
`ARG`, for anything secret. `buildEnv` — public build-time values like
`NEXT_PUBLIC_*` — can be `ARG`.

### Concurrency and cost

Build-seconds per deploy go up 3–6×, and up to 24× on a repaired deploy. Nothing
throttles: `LIMITS` has only `maxApps`, `maxGrants`, `autoFix`, `canRemoveBadge`
(`entitlements.ts:24–27`); the reserve endpoint gates on `maxApps` alone; dispatch
is fire-and-forget `--async` (`deploy-runs.ts:280–286`); every deploy also holds a
Cloud Run Job task at `--memory 4Gi --cpu 2` for the whole build
(`setup-deploy-job.sh:87–89`) with `--max-retries 0`. No private pool is
configured (`build-config.ts:96–103`, deliberately), so this lands on the shared
default pool and its per-project concurrent-build quota.

A queued build is indistinguishable from a slow app in the CLI — and
`deploy-errors.ts:42` classifies `quota|rate limit|resource exhausted` as
platform blame, so repair never runs and the user sees a generic stall.

**Work, before cutover:** measure build-minutes and image bytes per deploy on the
new path against today's; state the concurrent-build headroom; add a per-owner
in-flight-deploy cap in `reserve` — the endpoint that already refuses over-limit
deploys — so a queue is refused visibly rather than experienced as a hang.

---

## Order

| # | Work | Days |
|---|---|---|
| 0 | `stamp.mjs` bundle manifest; buildkit prerequisites (mirror `moby/buildkit`, set `BUILDKIT_IMAGE`, canary `--push` auth) | 1 |
| 1 | `detect.ts` + rewrite `repo-runtime.ts` for 7 languages, **with resolve + validate**; move `bindToPort`/`pythonModule`/`pythonInstall` in and rewire `inferAppConfig`; `database` and `release` derivation | 5 |
| 2 | Manifest-COPY rewrite (path-preserving, present-on-disk, non-empty); Dockerfile templates: multi-toolchain per `dir`, `proxyWait` + a probe that exists in every base, PATH, `HUSKY=0`, `needs` | 3 |
| 3 | **Build-time secrets + `buildEnv` into `cachedBuildConfig`** — blocks step 4 | 1 |
| 4 | Collapse routing behind a re-scoped `RUNNER_ENABLED`; rebuild siblings on generated images (per-service image/Dockerfile/cache/context); `supersonic check` + `resolver.entry.ts` in the same commit | 4 |
| 5 | buildkit default + base-image mirror + **digest pinning** | 1 |
| 6 | **Dedicated build SA; registry GC in `deleteApp`; slug-reuse fix; per-owner deploy cap** | 2 |
| 7 | Stage the pipeline + the `deploy_stages` / analytics mapping | 3 |
| 8 | `classify` rework (stage-scoped, terminal-line); repair classifier; Dockerfile patching + pathspec + persistence + rerender | 4 |
| 9 | Dockerfile cache (with `TEMPLATE_VERSION`) + config write-back | 2 |
| 10 | Fleet backfill + decommission query; delete `services/runner/` | 1 |
| 11 | Auto-rollback, watch, backups | 3 |

**30 working days**, of which steps 0–4 (14 days) are what turn zero into
most-things-work. The first draft's 19 was not wrong about the shape — it omitted
row 0, row 3, row 6 and row 10 entirely, and rows 1 and 4 were under-scoped by
the work the audit found (per-directory toolchains, the version resolver, the
sibling plumbing, the CLI bundle).

Steps 5, 9 and 11 can slip without blocking anything. Step 3 cannot: it is a
regression on the largest language on the platform.

---

## The one real risk

**Every app changes path at once.** Deleting the runner means apps that deploy
successfully today take a route they have never taken, and siblings change
mechanism entirely.

The first draft proposed `RUNNER_ENABLED` (`:1654`) as the two-week rollback.
**As it exists, it cannot be.** `deploy-pipeline.ts:92` defines it, `:1654` passes
it to `laneFor`, and `resolve.ts:211` is the whole of what it does:
`if (wantsRunner) return runnerAllowed ? "runner" : (i.dockerfile ? "container" : "buildpack")`.
So `RUNNER=0` does not mean "use the new path" — it means "use the buildpack
lane", which the collapse deletes, along with `laneFor` itself.
`cloudbuild.yaml:85` confirms `RUNNER=1` is live today.

It also does not gate siblings at all: `deploySibling` picks a runner image at
`:2366`, mints a code key at `:2368`, writes `runnerPrepareConfig` at `:2378`,
stores the key at `:2433` and deploys `lane: "runner"` at `:2443` — none of it
behind the flag. Flipping it
would half-revert.

What actually gives a rollback:

1. **Re-scope the flag** to select between two build *implementations* inside the
   new `build` stage — `RUNNER=1` → the old runner path, `RUNNER=0` → generated —
   not between lane strings. Thread it into `deploySibling` too.
2. **Hold back the delete rows** listed under "Delete — only after decommission".
   The runner's code, images and `build.sh` stay in the tree past the window.
3. **Backfill.** The flag only affects *new* deploys, and nothing in the repo
   redeploys apps on its own. "Nothing is using it" never becomes true by
   waiting — the population of live runner revisions does not shrink. A backfill
   that redeploys every live app on the new path is a required step, not an
   optional one.
4. **A concrete decommission test.** `serviceList()` already returns each
   service's image (`gcloud.ts:98`) — the test is a query for services still on
   `runner-node` / `runner-python`, run until it returns empty. Every live runner
   revision also depends on a GCS artifact, `ready/<slug>/<release>.tgz`
   (`:1994, :2417`), which only `deleteApp` removes — so the registry cleanup
   policy from Part 9 must exempt the runner images until this query is empty, or
   scale-from-zero breaks for every un-migrated app.

That is the flag re-scoping inside row 4 plus the whole of row 10, ~2 days, not
the 1 the first draft booked. It is the difference between a migration and an
outage.

---

## Rules

- No new schema fields until deploys work. Five documented cases of a field
  accepted, validated, printed back, and ignored — `buildEnv` is the sixth, and
  Part 3 either wires it or removes it rather than letting it become the seventh.
  Part 6's write-back markers are the one intended exception; it is granted
  explicitly, or it goes in a sidecar.
- Deterministic first; the model runs only after a failure, never before a build.
- Nothing is deleted before its replacement is green, and nothing is deleted from
  the tree while a live revision depends on it.
- Don't touch `services replace`, worker pools, crons, or `SEAL_APPS`. Landed,
  additive, and not why nothing deploys. (Worker pools do change delivery
  mechanism with the runner — that is step 4's job, and it is the one exception.)
- Don't add Nixpacks. It would own the artifact, and the repair loop requires
  that we do. Reconsider it later as an unknown-language fallback *after*
  `detect()` and *behind* the generated path.
