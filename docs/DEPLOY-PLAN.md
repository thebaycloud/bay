# Deploy anything — the plan

**Status:** in progress — see the log at the end
**Written:** 2026-08-01, against `0fd8957`
**Goal:** Supersonic deploys an arbitrary repository, first attempt, and knows whether it worked.

Out of scope by decision: GitHub / git-URL deploys. The local folder is the product surface;
everything below assumes the CLI is the entry point. Several simplifications fall out of that
and are noted where they do.

---

## 1. The single architectural change

Everything here follows from one move: **one resolved config, one consumer.**

"Apply the plan" is currently implemented seven times:

| Where | File |
|---|---|
| static lane | `deploy-pipeline.ts:1334` |
| runner lane | `deploy-pipeline.ts:1538` |
| sibling deploy | `deploy-pipeline.ts:1444` |
| Dockerfile lane | `deploy-pipeline.ts:1721` |
| buildpacks lane | `deploy-pipeline.ts:1723` |
| prepare step | `services/runner/prepare.sh:103-121` |
| container start | `services/runner/entrypoint.sh:108-133` |

Adding a plan field means finding seven readers, and nothing fails when you miss one. That is
the generator of every failure below. A plan field is only as real as the number of lanes that
happen to read it, so the failure surface is the *product* of repo shapes — language × static
or runner primary × siblings × DB × subdirectory × declared runtime — while the test suite adds.
Eight apps passing tells you almost nothing about the ninth.

`supersonic.json` does not fix this. It fixes who *authors* the description; the bug is who
*reads* it. A config that was present, valid, hand-written and correct still failed, because it
was threaded into the runner lane and never the static one.

### 1.1 Target shape

```
AUTHORING — local, deterministic, no cloud, no model
  supersonic init   → repo-facts + detector → supersonic.json (a DRAFT)
  agent reviews     → fills what static analysis cannot know
  supersonic check  → resolve + validate + print, ~2s, no GCP

           ↓  assets to GCS (direct) + code bundle + supersonic.json

RESOLUTION — server, ONE place
  resolve(dir) → ResolvedApp
    · source: config | inferred
    · validate against the repo (dirs exist, modules import, outputDir produced)
    · reject platform-owned names at parse time

           ↓  ResolvedApp — the only thing anything downstream reads

PROVISION
  per-app database + per-app ROLE · per-app bucket · secrets → Secret Manager
  compute deployment facts (hostname, scheme, path prefix)

           ↓  ServiceEnvelope, identical for every lane

EXECUTE — one code path; lanes are strategies, not forks
  build → release (once, before traffic) → deploy
  assert-consumed: a field no lane read is a hard failure

           ↓

VERIFY — HTTP, not exit codes
  health path · assets resolve · no console errors → then flip the pointer
```

### 1.2 The type everything hangs off

```ts
interface ResolvedApp {
  source: "config" | "inferred";
  resources: {
    database?: { engine: "postgres"; version: string };
    bucket?: boolean;
  };
  services: ResolvedService[];
  facts: DeploymentFacts;          // computed by the platform, never authored
}

interface ResolvedService {
  name: string;
  dir: string;
  path: string;                    // "/" or "/api"
  lane: "static" | "runner" | "container" | "buildpack";   // DERIVED, not authored

  runtime?: string;                // "python3.12" | "node22" | "java21"
  framework?: string;              // "django" | "next" | "vite" | "fastapi"

  install?: string;
  build?: string;
  release?: string;                // runs ONCE, before traffic
  start?: string;

  outputDir?: string;              // static only
  spaFallback?: boolean;           // static only
  dockerfile?: string;             // container lane
  context?: string;                // container lane build context

  uses: ("database" | "bucket")[];

  env: Record<string, string>;     // non-secret literals
  buildEnv: Record<string, string>; // baked at build time (VITE_*, NEXT_PUBLIC_*)
  secrets: string[];               // NAMES only, enforced not logged

  health: { path: string; expect: number };
  scale: { memory: string; cpu: number; maxInstances: number; timeout: number; concurrency: number };
}

interface DeploymentFacts {
  hostname: string;
  scheme: "https";
  pathPrefix: string;
  siblingUrls: Record<string, string>;
}
```

`lane` being **derived** rather than authored is the point. Users declare what the app *is*;
the resolver decides how it is built; one executor consumes the decision.

---

## 2. `supersonic.json` — the contract

### 2.1 Should it be enforced?

**Yes as the internal contract. No as a hand-authoring requirement. Made inevitable in practice.**

No human writes this file. The author is always a coding agent, in one of two states:

- **State 1 — empty chat.** No context, but full file tools. Exactly as capable as a remote
  planner, running locally, on the user's tokens, with no job handoff in front of it.
- **State 2 — active build chat.** Wrote the app. Knows install / build / start / DB / env cold,
  without reading anything.

There is no third author, so the objection "a human with a folder of HTML shouldn't need one"
is void. Both states produce the file. `supersonic init` produces a draft in ~2 seconds with
no model call at all.

Three rules:

1. **Required internally.** Every deploy resolves to exactly one `ResolvedApp`, and nothing
   downstream reads anything else. No lane touches detector fields. No lane re-derives a language.
2. **Assert-consumed.** Every field in the resolved config must be read by the lane that ran, or
   the deploy fails in five seconds naming the field. Declaring a thing creates an expectation
   that it takes effect; ignored-but-present is the last silent asymmetry.
3. **Optional externally, inevitable in practice.** Absent → infer, then hand the resolved file
   back (the `supersonic patch` delivery mechanism already exists). The CLI refuses to deploy
   without one and offers `init`.

### 2.2 Schema v2

```jsonc
{
  "version": 1,

  // Provisioned ONCE per app. Today provisioning is driven by the PRIMARY service's
  // plan, so a sibling that needs a database does not get one.
  "resources": {
    "database": { "engine": "postgres", "version": "16" },
    "bucket": true
  },

  "services": [
    {
      "name": "web",
      "dir": "frontend",
      "path": "/",
      "language": "static",
      "runtime": "node22",
      "framework": "vite",

      "install": "npm ci",
      "build": "npm run build",
      "outputDir": "dist",
      "spaFallback": true,

      "env": { "NODE_ENV": "production" },
      "buildEnv": { "VITE_API_BASE": "/api" }
    },
    {
      "name": "api",
      "dir": "backend",
      "path": "/api",
      "language": "python",
      "runtime": "python3.12",
      "framework": "django",

      "install": "pip install --no-cache-dir -r requirements.txt",
      "release": "python manage.py migrate --noinput && python manage.py collectstatic --noinput",
      "start": "gunicorn config.wsgi --bind 0.0.0.0:$PORT",

      "uses": ["database", "bucket"],

      "env": { "DJANGO_SETTINGS_MODULE": "config.settings.production", "LOG_LEVEL": "info" },
      "secrets": ["DJANGO_SECRET_KEY", "STRIPE_SECRET_KEY"],

      "health": { "path": "/api/health", "expect": 200 },
      "scale": { "memory": "1Gi", "cpu": 1, "maxInstances": 10, "timeout": 300, "concurrency": 80 }
    }
  ]
}
```

**New fields and what each closes:**

| Field | Why | Closes |
|---|---|---|
| `resources.database` (top level) | Provisioning is once per app; two services share one database. `needsDB` stays as a deprecated per-service shorthand that ORs in. | provisioner bug |
| `uses: [...]` | Says which services receive credentials — the unit per-app DB isolation is scoped to. | goal: per-app DB |
| `runtime` | The pipeline detects `requires-python >= 3.14`, logs "the build will probably fail on it", and builds anyway. | #28, #29 |
| `framework` | One token letting the platform inject proxy-awareness. The app cannot configure for a proxy it does not know exists. | #14, #15 |
| `release` (was `preDeploy`) | Runs once, before traffic. | #11 |
| `env` as an object | Non-secret literals, committed, deploy-shaping. | #4 |
| `secrets[]` | Names only, **enforced** — a missing secret fails before the build. | #4 |
| `buildEnv` | `VITE_*` / `NEXT_PUBLIC_*` are baked at build time and useless at runtime. | #17 |
| `spaFallback` | React Router 404s on refresh at `/about`; nothing can say otherwise today. | goal: any static |
| `health.path` | Success stops meaning "the process did not exit". | #23, #24, #25 |
| `scale` | Only the runner lane sets memory; container lanes get 512Mi and OOM. | #21, #22 |
| `dockerfile` + `context` | A nested `backend/Dockerfile` is discoverable and unusable today. | tier-3 languages |

**Three parse-time rules:**

1. **Platform-owned names are a parse error.** If the file or the `.env` declares `DATABASE_URL`,
   any `POSTGRES_*`, `PG*`, `DB_*`, `PORT`, or `SUPERSONIC_*` — fail, naming the variable.
   `PLATFORM_OWNED` (`envfile.js:29-36`) lists 6 names; `databaseEnv()`
   (`deploy-pipeline.ts:324-334`) sets 17. The fix is not adding 11 names — it is **deriving the
   protected set from `databaseEnv()`** so it can never drift again. (#18, #19)
2. **`secrets[]` is enforced.** Today `envNeeded` is logged at `:1139` and checked nowhere.
3. **`LOCAL_HOSTS` becomes per-value, not whole-value.** `envfile.js:40,112` drops any value
   *containing* `localhost`, so `CORS_ORIGINS=https://app.com,http://localhost:3000` is dropped
   entirely. Strip the local entries, keep the rest, say so. (#20)

**Deliberately excluded:** any `routes` or `rewrites` block. The moment the file can express
request transformation it is a config language, and you debug user-authored routing tables
instead of deploys. `path` per service is enough.

### 2.3 The simplest possible file

A plain HTML/CSS/JS folder:

```json
{ "version": 1, "services": [{ "language": "static", "outputDir": "." }] }
```

This is the one case where `init` is right with certainty — nothing to infer, so states 1 and 2
produce the same file. It also already hits the fastest path in the platform: with no install or
build command, `needsBuild` is false (`deploy-pipeline.ts:1502-1520`), Cloud Build is skipped
entirely, and the folder rsyncs straight to the bucket. **Do not let schema growth drag this case
through a heavier path.**

The file still matters here, for one reason: `outputDir: "."` currently means two opposite things.

1. "This folder is the site." Correct, for plain HTML.
2. "I have no idea what this is." `detectStack` reads only the repo root, a monorepo matches
   nothing, and it falls through to `staticSite()` with `outputDir: "."` — publishing a raw
   source tree as a website. (#32)

Same value, opposite meanings, and the second is a **silent wrong success**. A file written by an
agent that looked is a declaration; a `"."` from a detector that matched nothing is a shrug. The
file is carrying *intent*, not configuration.

### 2.4 Language coverage

| Tier | Languages | Lane | Config needed |
|---|---|---|---|
| 1 | node, python, static | runner / static | none — `init` gets it |
| 2 | go, java, ruby, php, .NET | buildpacks | `runtime` + `start` |
| 3 | rust, elixir, deno, haskell, … | your Dockerfile | `dockerfile` + `context` |

`install` / `build` / `start` are just strings — they were never language-specific. The one
structural difference is that Node and Python are *interpreted* (source ships, deps install at
build, start runs the source — the runner lane's whole model) while Rust, Java and Go are
*compiled* and need a build toolchain that must not exist at runtime. That is a two-stage build,
which is what the container and buildpack lanes are for.

The right expression of that is not a bigger language enum — it is admitting the lane is a
separate axis: `dockerfile` present → container; `runtime` names a compiled runtime → buildpack;
otherwise → runner or static. `language: "other"` stops being a shrug meaning "try buildpacks and
hope".

**Today a perfect config for a Rust API with `uses: ["database"]` deploys a container with no
`DATABASE_URL`, no secrets, no proxy sidecar, on 512Mi.** The schema is expressive enough;
nothing reads it on that path. See Phase 0.

**Accepted limitation:** tier 3 means no zero-config for Rust or Elixir — an agent must write a
Dockerfile. Those ecosystems expect that, and auto-generating one means maintaining a build
matrix for every language, which is the buildpacks project's job.

---

## Phase 0 — Lane parity

*2 days. Blocking. Independent of everything else. Do first.*

Verified still open at `0fd8957`.

`appFlags` — which carries `--update-env-vars` and `--update-secrets` — is built at
`deploy-pipeline.ts:1403-1407` and used at exactly one call site: `:1700`, the runner lane.

- Dockerfile lane, `:1721` → `["run","deploy",slug,"--image",IMAGE,...deployFlags]`
- Buildpacks lane, `:1723`/`:1726` → `["run","deploy",slug,"--source",dir,...deployFlags]`

`deployFlags` is region, project, allow-unauthenticated, format, labels, service account. No env.
No secrets. No `--depends-on cloudsql-proxy` (only at `:1504` and `:1701`). No `--memory`.

So any app on a container lane deploys with an **empty environment** and no network path to the
database the pipeline just provisioned for it.

| Fix | Change |
|---|---|
| **#0** | Append `...appFlags` and the cloudsql sidecar block to `:1721`, `:1723`, `:1726` |
| **#21** | `--memory` on all lanes. 512Mi kills any JVM or Next.js before it binds `$PORT` |
| **#22** | `--max-instances` (unbounded spend), `--timeout` (a long export dies at 300s), `--concurrency`, `--cpu-boost` |

**The test that makes it stick:** one table-driven test looping over the lane list, asserting each
lane's argv carries env, secrets, memory, max-instances, and — when `cloudsql` is set — the proxy
sidecar. Not four tests; one loop, so a fifth lane cannot be added without appearing in it.

**Also here:** the lane flags (`RUNNER`, `PLANNER`, `SEAL_APPS`, `DEPLOY_ENGINE`, `DEPLOY_JOB`)
exist nowhere in the repo — they are set by hand on the live service. `cloudbuild.yaml:36-38`
explains exactly why that is dangerous, about the *resource* flags, and then does the same thing
with the flags that select which pipeline runs. Put them in `cloudbuild.yaml`.

**Why first:** largest coverage gain per line in the plan, and per-app DB isolation (Phase 5) is
impossible for tiers 2 and 3 until it lands.

---

## Phase 1 — Transport, fidelity, and media

*Promoted: projects contain images, GIFs and video, and all three of these break on them.*

### 1a — What gets sent is wrong

`packages/cli/index.js:743-745` excludes 19 patterns plus `.gitignore`. Three defects:

- **Basename matching at any depth.** `dist`, `build`, `out`, `vendor`, `target`, `.cache` match
  anywhere, so `src/build/` (a module named build), `app/vendor/` (Composer, Go `-mod=vendor`),
  and a committed `dist/` that *is* the deliverable are silently stripped. Nothing logs it. (#7)
- **`.gitignore` handed to `tar --exclude-from`.** tar does not speak gitignore: negations
  (`!keep.js`) become literal patterns, anchored patterns (`/dist`) never match, `**/` semantics
  differ. Tracked files get dropped and surface as "module not found" three stages later. (#8)
- **Two source models.** Folder deploys ship the denylist minus `.gitignore`; the git path ships
  everything committed. The same repo produces two different trees. (#9)

**Fix:** let git compute it.

```
git ls-files -z --cached --others --exclude-standard | tar --null -T - -czf …
```

Real gitignore semantics, computed by git rather than imitated by tar. Fall back to the current
denylist when there is no `.git`. **Log what was excluded and why** — nothing does today.

Also in this pass (#6, #10):

- preserve the executable bit on entrypoint scripts
- `.git` metadata when a build needs it (`setuptools-scm`, `versioneer`, `git describe` — no tags
  means `0.0.0` or a hard failure)
- a macOS case-collision check (`./button` vs `./Button` works on every dev machine and fails on
  Linux)
- **git LFS pointers** — a repo storing video in LFS ships 130-byte text files that look like
  media and are not. Detect and either fetch or fail loudly.

### 1b — How it gets sent is a wall

`route.ts:161` — `Buffer.from(await req.arrayBuffer())` — materializes the entire tarball in the
control plane's memory, then `createRun` encrypts it and writes it to
`gs://…/runs/<runId>.tgz.enc`, and the job downloads it again. **GCS is the destination. The
control plane is a courier that buffers the whole parcel.**

| Limit | Value | Failure |
|---|---|---|
| Cloud Run max request size | 32 MiB | Rejected at the load balancer *before the handler runs* — nothing in the pipeline can explain it |
| Request timeout | 300s default | A slow uplink on a large repo dies with no diagnosis |
| Control-plane memory | shared | Every concurrent deploy holds its full tarball in RAM |

With media in the tree, 32 MiB is a routine ceiling, not an edge case.

**Fix — signed URL, direct to GCS:**

1. CLI → `POST /api/deploy/upload-url` (tiny JSON) → signed resumable GCS URL + run id
2. CLI encrypts locally and `PUT`s straight to GCS — resumable, no size wall, no control-plane
   memory, no request timeout, and real progress reporting
3. CLI → `POST /api/deploy` with the object name instead of the body
4. Job reads from GCS exactly as it does today

Falls out for free: **the plaintext bundle never exists on the control plane.** Today it is held
decrypted in memory. Pairs with Phase 5c (getting `SUPERSONIC_CODE_KEY` out of the revision spec)
— the key is issued alongside the signed URL and goes straight to Secret Manager.

Keep the current path behind a flag until the new one is proven.

### 1c — Media destroys cold starts on the runner lane

`services/runner/entrypoint.sh` `fetch_code()` runs at **container start**, on every cold start
and every scale-out instance:

1. download the full bundle from GCS
2. `openssl enc -d -aes-256-cbc` the whole thing (single-threaded)
3. `tar -xzf` the whole thing
4. only then reconcile deps, build, and bind `$PORT`

For a 200 MB media-heavy app that is minutes, on every instance, inside Cloud Run's startup probe
deadline. This is a different problem from the upload wall and it is worse, because it recurs.

Two changes:

- **Stop gzipping incompressible content.** JPEG, PNG, GIF, MP4, WebM and WOFF are already
  compressed; `-czf` burns CPU on both ends for nothing. Use store-only or zstd for those
  extensions.
- **Assets do not belong in the runtime bundle.** The per-app GCS bucket already exists and is
  already provisioned. Split the upload: *code* (small, changes constantly, goes in the bundle)
  and *assets* (large, changes rarely, uploaded once by content hash, served directly from the
  bucket through the proxy). Cold start returns to code-sized, redeploys stop re-uploading
  unchanged video, and assets get a CDN story for free.

The asset split is the substantial piece of this phase. It is also the difference between "media
projects work" and "media projects technically deploy".

---

## Phase 2 — Schema v2 and the resolver

Implement §2.2 — the new fields, the three parse-time rules, and `resources`.

### One source of truth for runtime versions

Three exist and they already disagree:

| Source | Says |
|---|---|
| `services/runner/python/Dockerfile:15` | `python:3.14-slim` |
| `services/runner/node/Dockerfile:12` | `node:24-slim` |
| `plan-deps.ts:172` `RUNTIME_VERSIONS` | python 3.14, node 24 (hand-maintained mirror) |
| `services/deploy-agent/src/index.ts:218` | **`python:3.12`** — wrong |

Generate `RUNTIME_VERSIONS` from the Dockerfiles, or add a test parsing both and asserting
agreement. Then make `runtime` a **hard gate**: `plan-deps.ts:195` already detects the mismatch
and `:554` logs "the build will probably fail on it — this is a platform limit, not your app",
and then builds anyway, fails, and pays the repair agent to rediscover it. (#28, #29)

### The resolver

`lib/resolve.ts` — one function, two sources, one output:

```ts
resolve(dir): ResolvedApp
  1. readAppConfig(dir)          → source: "config"
  2. inferAppConfig(dir, detect) → source: "inferred"
  3. validate(app, dir)          → throws with the field named
```

`validate` is what makes `check` possible: `dir` exists; `outputDir` is produced by `build` or
already present; the Python module imports; `dockerfile` + `context` resolve; no two services
claim a path; `release` is not declared on a static service.

**The model planner is not in this list.** See Phase 4.

---

## Phase 3 — Single consumer and assert-consumed

The refactor. Delete the seven implementations; leave one.

```ts
execute(app: ResolvedApp)
  for each service:
    envelope = buildEnvelope(service, app, app.facts)
    lane     = LANES[service.lane]
    assertConsumed(envelope, lane.consumes)     // ← before anything runs
    lane.build(envelope) → lane.release(envelope) → lane.deploy(envelope)
```

Each lane is an object with those three methods and a **declared capability set**. A field present
in the envelope that the lane does not declare is a hard failure naming it:

```
✕ static lane does not implement: release, secrets
  Move them to a service with a `start` command, or remove them.
```

This is the same move already made twice — `language: "other"` as an explicit decision rather than
a silent fall-through, and malformed config as a hard stop. It converts "discover at attempt 7
after 428k repair-agent tokens" into a five-second failure that names the field.

Folded in:

- **The static lane stops reading detector fields.** `:1035-1036` hand-copies plan values into
  `s.installCommand` / `s.buildCommand` because the static lane reads the detector, not the plan.
  That copy fixed one bug; this removes the pattern that required it.
- **`plan.port`** (`opencode-deploy.ts:228`) is documented and read nowhere. Consume it or delete
  it — assert-consumed forces the choice.
- **Nested Dockerfiles become usable.** `infer-services.ts:236` bails on any repo with a root
  Dockerfile, and `repo-facts.ts` deliberately reports nested ones without acting ("a nested
  Dockerfile needs a build context nobody has chosen yet"). `context` is that choice.

**Risk control:** run old and new paths in parallel behind a flag, diffing resolved argv on real
deploys, before cutting over. This is why Phase 0 moves the lane flags into `cloudbuild.yaml` —
you cannot reason about a cutover when only the running revision knows which path is live.

---

## Phase 4 — Local authoring, and deleting the planner

### `supersonic init`

Move into `packages/cli`: `repo-facts.ts` (212 lines), `infer-services.ts` (286), the detector
(`services/deploy-agent/src/index.ts`, 355), and the manifest half of `plan-deps.ts`. **All are
node-builtins-only with zero runtime dependencies** — verified; `services/deploy-agent` has only
`tsx` and `typescript`, both devDependencies. Roughly 1000 lines move as-is and run in ~2 seconds.

Determinable locally, from files alone: language per directory, the monorepo split, install
command from the lockfile, build command and `outputDir`, start command, **runtime version**
(`engines.node`, `requires-python`, `.nvmrc`, `.python-version`), `needsDB` from a dependency
scan, env var names from a `process.env` / `os.environ` grep, and framework from dependency names.

Not determinable, ever, by static analysis — and exactly what a state-2 agent knows cold:

- which service owns `/` when both are servers
- whether `alembic upgrade head` *should* run, versus alembic merely being installed
- whether a committed `dist/` is the deliverable or stale
- SPA-fallback intent
- which env vars are secrets

Output is a **draft** and says so:

```
Wrote supersonic.json — 2 services detected.

  /      frontend   static   npm ci && npm run build → dist
  /api   backend    python   uvicorn app.main:app --port $PORT

Three things I could not determine — check them:
  · does `backend` need a migration before traffic?  (release: …)
  · should unknown paths serve index.html?           (spaFallback)
  · which secrets does it read?                      (secrets: [])
```

**Review beats authoring.** Never ask a state-1 agent to produce JSON from nothing — ask it to
correct a draft. The local detector is the same one that read a `frontend/`+`backend/` root as
"Static site, 80% confidence" and was wrong. But its wrong answer now lands *in a file, in front
of an agent, before anything deploys*, instead of silently selecting a lane on a server 200
seconds later. Same code, radically better position: its failures become reviewable instead of
invisible.

### `supersonic check`

The local dry run. Same `resolve()` + `validate()`, prints per service exactly what each phase
would run, exits non-zero on any error. No GCP, no build, ~2 seconds.

Because the author is always an agent, this puts the iteration loop **on the user's machine, on
the user's tokens**, at 2 seconds instead of 11 minutes. Eleven attempts becomes twenty seconds.
It fixes zero deploys directly and it is the highest-leverage item in the plan, because it is the
multiplier on every other fix.

### Delete the model planner from the critical path

With GitHub deploys out of scope, the planner loses its last justification. It was already
dominated in both agent states — state 2 knows the answer without reading anything; state 1 does
the same job locally with file tools, faster. It costs 40–180s, thrashes on some repos, and plans
the same repository differently on consecutive days.

Remove it from `resolve()`. Keep `plan-cache.ts` (it is correct) only if the planner survives
behind a flag; otherwise both go.

Consequences that also disappear: the 40-call `SIGKILL` loop guard leaving truncated `plan.json`
(#31), and `PartialPlan` handling in the pipeline.

---

## Phase 5 — Per-app database isolation

### What is shared today

| Layer | Shared? | Evidence |
|---|---|---|
| Cloud SQL instance | yes — one, `supersonic-shared-pg` | `provisionPostgres`, `deploy-pipeline.ts:277` |
| Logical database | no — one per app | `dbNameForSlug(slug)` |
| Postgres user + password | **yes — identical for every app** | `pgConfig()` returns a single user/password |
| Per-app role | **never created** | zero hits for `CREATE ROLE` / `GRANT` / `REVOKE` in the repo |

`pgConfig()` defaults the user to `postgres` — the `cloudsqlsuperuser` role — and `databaseEnv()`
(`:324-334`) writes that one credential into every app's environment seventeen ways.

Postgres grants `CONNECT` to `PUBLIC` on new databases by default and nothing revokes it, so any
app reaches any other app's database by changing a connection string. Not an exploit — a one-line
config change. The Cloud SQL proxy does not help: `roles/cloudsql.client` is scoped to the
instance.

Worse: `supersonic_platform` is on that same instance through the same `pgConfig()`
(`db.ts:11-14`). Every customer container can read `users`, `apps`, `deploy_runs` (which holds
other customers' `.env` secrets for the duration of their builds), `deploy_events`, and
`cli_tokens` — and **write** to all of them. Nothing stops `UPDATE apps SET run_url = …`.

The codebase reaches the opposite conclusion three times elsewhere, each with a comment saying
why: per-bucket grants ("a project-level grant would hand every app the keys to every other app's
storage"), a dedicated runtime service account ("arbitrary code we agreed to run"), and per-app
AES bundle encryption. Postgres got none of them.

### 5a — Per-app role

At provision time, beside the `databases create` already run:

```sql
CREATE ROLE app_<slug> LOGIN PASSWORD '<random>';
REVOKE CONNECT ON DATABASE <db> FROM PUBLIC;
GRANT  CONNECT ON DATABASE <db> TO app_<slug>;
GRANT  ALL ON SCHEMA public TO app_<slug>;
```

`databaseEnv()` gets that role instead of `cfg.user` / `cfg.password`. Password into Secret
Manager, never an `--update-env-vars` literal. Contained: `provisionPostgres` is the only producer
of those credentials, and the delete path already finds an app's database by name, so it can drop
the role alongside it.

**Depends on Phase 0** — useless for tiers 2 and 3 until those lanes have a proxy sidecar.

### 5b — Move the control plane off the shared instance

A per-app role does not restore this boundary while a superuser password exists in customer
containers at all. Separate instance, separate credential, non-superuser role for the control
plane.

### 5c — `SUPERSONIC_CODE_KEY` out of the revision spec

It goes in via `--update-env-vars` at `:1236` — the plaintext AES key for the encrypted bundle,
in exactly the place `app-secrets.ts:11-17` exists to keep values out of. The per-app bundle
encryption is defeated by the deploy that sets it up. Secret Manager ref.

---

## Phase 6 — The release phase

`app-config.ts:38-44` documents precisely why folding `preDeploy` into `start` is wrong —
*"folded into the start command, a migration re-runs on every cold start and every scale-out
instance, concurrently. Prisma takes an advisory lock and survives that; Alembic does not."* —
and then `planFromConfig:218` folds it into the start command. `:1044` and `:1460` do the same.

Live consequences: concurrent migrations on scale-out, a failed migration crashlooping every
instance with no rollback boundary, migration time on every cold start, and Cloud Run's startup
probe able to kill the container mid-migration.

**Why it cannot run in Cloud Build:** `app-secrets.ts` gets `DATABASE_URL` into the build via
`availableSecrets`, but the Cloud SQL proxy is a Cloud Run *sidecar* (`:343-354`). Cloud Build has
nothing listening on `127.0.0.1:5432`. The build holds a connection string pointing at a closed
port. Prisma passes only because `prisma generate` never connects; `manage.py migrate` hangs to
the 1200s timeout.

**The fix:** a Cloud Run **Job** per release — same image or bundle, same env, same secrets, **with
the proxy sidecar attached**. Runs once to completion before the pointer moves. Fails → the
release is abandoned and the previous revision keeps serving.

This is Heroku's build/release/run, correct since 2011, and absent from the pipeline. It unblocks
Django, Rails, Alembic and `prisma migrate deploy` — every stateful app, which is every app anyone
charges money for.

Also here: **`--depends-on` orders container start, not port readiness** (#13). An app that
connects at import time can still lose the race — add a proxy readiness wait to the entrypoint.

---

## Phase 7 — Deployment facts

Zero hits across the repo for `ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`, `FORCE_SCRIPT_NAME`,
`SECURE_PROXY_SSL_HEADER` or `X-Forwarded-*`. The app knows `PORT`, its database vars,
`STORAGE_BUCKET`, `GOOGLE_CLOUD_PROJECT` and its secrets. It does not know its hostname, its
scheme, or its path prefix.

### 7a — The proxy stops destroying the evidence

`services/proxy/src/headers.ts:5-11` — `DROP` contains `host`, and no `x-forwarded-*` is ever set.
The app sees the Cloud Run hostname over what looks like plain HTTP. Every absolute URL it
generates is wrong: OAuth `redirect_uri`, password-reset links, `Set-Cookie Domain`, canonical
tags, sitemaps, `request.build_absolute_uri()`. Django with `SECURE_SSL_REDIRECT` infinite-loops;
without a matching `ALLOWED_HOSTS` it returns 400 on every request.

Add `x-forwarded-host`, `x-forwarded-proto: https`, `x-forwarded-prefix`, and `forwarded`.

### 7b — Inject per framework

`framework` selects the mapping. The platform owns this because the app cannot know it is behind
a TLS-terminating proxy.

| framework | injected |
|---|---|
| django | `ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`, `SECURE_PROXY_SSL_HEADER`, `FORCE_SCRIPT_NAME` when prefixed |
| rails | `RAILS_HOSTS`, `FORCE_SSL` |
| next | `basePath` via `buildEnv`, `NEXTAUTH_URL` |
| flask / fastapi | `ROOT_PATH`, `ProxyFix` guidance |
| * | `SUPERSONIC_URL`, `SUPERSONIC_PATH_PREFIX`, `SUPERSONIC_SCHEME` |

### 7c — Path prefix

`routes.ts:48` picks by longest prefix; `forward.ts:17` forwards `req.url` verbatim. A sibling at
`/api` receives `/api/...` and must be written to serve under that prefix. Either strip it or
inject `FORCE_SCRIPT_NAME` / `ROOT_PATH` — but **decide**, because the current failure is a silent
404 on everything. (#16)

### 7d — `buildEnv` at build time

`envfile.js:126-131`: a `.env` over 8 KB returns null, and the vars are set *after* the build, so
the build runs without them. `VITE_*` / `NEXT_PUBLIC_*` are baked at build time and useless at
runtime — that is why they are a separate field. (#17)

---

## Phase 8 — Verification means the app works

`probeApp` returns `{ok: true}` on **any** exception, including its own 20s abort (`:447-449`).
Only 403, ≥500 and one body regex fail it — a framework 404 page passes, a 200 serving a blank
screen passes. The static lane never makes an HTTP request at all: `runStatic` verifies GCS
objects (`:1533-1545`), and `verify-release.ts` parses `index.html` for missing referenced files.
That last check is real and catches a missing stylesheet — but a JS error that blanks the page, or
`/about` 404ing on refresh, publishes clean.

**Definition of done, every lane:**

1. `GET health.path` returns `health.expect` — a timeout is a **failure**, not a pass
2. every asset referenced by the served HTML resolves (extend `verify-release` to the runner lanes)
3. no console errors on load
4. if `spaFallback`, an unknown path returns the shell, not a 404
5. only then does the pointer move

`services/shot` already exists and `requestThumbnail` at `:1712` is fire-and-forget and never
consulted. The "four bugs sitting on a screen a user looks at" gap is roughly one awaited call
from closed. `browse` and `qa` exist in the toolchain and are absent from the deploy path.

---

## Phase 9 — Prompts and agent context

### State 2 — active build chat

Copied at project *start*, so the file grows with the app instead of being retrofitted:

> This project deploys on Supersonic. Keep `supersonic.json` current as you build: one entry in
> `services[]` per deployable part, with its `dir`, `install`, `build`, `start`, and any `secrets`
> it reads **by name** (never values). Run `supersonic check` after changing it.

### State 1 — empty chat

Review, not authoring:

> Run `supersonic init` — it writes a draft `supersonic.json` from the repo. Then verify the four
> things it cannot determine: which service owns `/`, whether a migration must run before traffic
> (`release`), whether unknown paths serve `index.html` (`spaFallback`), and which env vars are
> secrets. Run `supersonic check` until it passes, then `supersonic deploy`.

### The repair agent gets context

Today it receives an error string. Give it the `ResolvedApp`, the lane chosen, the service it is
in, the directory it is running in, the deployment facts, and the failing phase — and state
explicitly which of those are platform-owned and not its to edit. `AGENT_MD:187` already tells it
not to fix platform limits; it is simply not given the information to tell the difference. That is
how it invented an app, wrote a fake `.env`, deleted a migrate script, and spent 428k tokens on
`gcloud exited 1`.

### Error classification in code

Only `IAM_FAILURE` and `AMBIGUOUS_STACK` short-circuit (`:1746`). A gcloud crash, a missing `dist`,
a runtime mismatch, a `POSTGRES_DB` collision — all handed to a model with edit access to the
customer's repo. Classify in code so those never reach the agent. **The repair agent must not be
load-bearing for platform bugs.** (#27)

Also: `MAX_REDEPLOYS = 3` with no identical-error check (`opencode-deploy.ts:59`) — the bridge
counts attempts and nothing compares errors. (#30)

---

## Ordering

```
Phase 0  lane parity ──────┬──────────────────┬─────────────────┐
                           ↓                  ↓                 ↓
Phase 1  transport    Phase 2  schema    Phase 5  per-app DB
  + fidelity            + resolver             ↓
  + media               ↓                 Phase 6  release phase
                   Phase 3  single consumer         ↓
                        ↓                            ↓
                   Phase 4  init + check ──→ Phase 7  deployment facts
                        ↓                            ↓
                        └────────────→ Phase 8  verification
                                              ↓
                                       Phase 9  prompts + agent context
```

- **0 first** — cheap, blocking, biggest coverage gain per line.
- **1 in parallel** — different files entirely; media projects are broken today in three ways.
- **4 as early as it is meaningful** — it needs the resolver (a dry run over seven lanes is as
  unreliable as the lanes), but once it lands every later phase is testable in 2 seconds instead
  of 11 minutes.
- **5 and 6 parallel to 2/3** — different files; 5a only depends on Phase 0.
- **8 last** — it is the check that everything above worked, and the thing that will find what
  this plan missed.

---

## Scope

**Fixed:** the seven-implementation bug class · silent ignored fields · all four lanes at parity ·
Rust / Java / Go / Ruby / PHP genuinely deployable · monorepos · static SPAs · media-heavy
projects (upload, fidelity, and cold start) · per-app database isolation · cross-tenant database
access · migrations · Django / Rails / Next behind a proxy · real success criteria · a 2-second
local loop.

**Explicitly out:** GitHub / git-URL deploys, and therefore private-repo credentials and the model
planner.

**Known open, not on the path to "deploy anything":**

- No second backing service — no Redis, queue, cron or background worker. Django + Celery is out
  of reach. (#—)
- `claimRun` is a plain `SELECT` with no status column or `UPDATE … RETURNING`; Cloud Run Jobs
  retry on failure by default, so a retry deploys twice. (#35)
- `supersedeRunsFor` cancels by listing executions and substring-matching run ids inside
  `spec.template.spec.containers[0].args` — racy and best-effort. (#36)
- `staticUrlCache` is a process-lifetime cache with no invalidation. (#37)
- Warm deploy worker (−79s) and the rest of the speed roadmap. Phase 1's `run-fetch` and
  `job-cold-start` stages will say how much of the 227s gap is bytes versus scheduling — measure
  before building it.

---

## Implementation log

2026-08-01. Commits are on `main`, oldest first. Every phase below is unit-tested
and typechecks; **nothing here has been exercised against a real deploy yet** —
that is the next thing to do, and the first place these will be wrong.

*Update, later the same day: the container lane has now been exercised, with
umami — a Next.js app with a root Dockerfile, Prisma migrations and a seeded
half-million-row Postgres. It found four things, all of them in the gap between
"unit-tested" and "has met gcloud". See "What the first container-lane deploy
found" below.*

| Phase | State | Commit |
|---|---|---|
| 0 — lane parity | done | `Give every lane the environment only one of them had` |
| 1a — transport fidelity | done | `Send what git says the repo is, not what tar guessed` |
| 1b — signed-URL upload | **not started** | — |
| 1c — media / cold start | **not started** | — |
| 2 — schema v2 + resolver | done | `Resolve an app once, and name the field when it cannot` |
| 2 — runtime version drift | done | `Refuse a runtime the platform does not have` |
| 3 — assert-reached | done | `Fail a deploy that did not apply what it was told` |
| 3 — single-consumer executor | **not started** | lanes still read three objects for the same facts |
| 4 — init + check | in progress | — |
| 5a — per-app DB role | done | `Give each app a Postgres login of its own` |
| 5b — control plane off the shared instance | **not started** | — |
| 5c — code key out of the spec | done | `Stop shipping the bundle key in the spec that hides it` |
| 6 — release phase | done | `Run migrations once, before traffic` |
| 7a — proxy forwarded headers | done | `Stop destroying the evidence` |
| 7b — framework injection | done | `Tell an app where it actually lives` |
| 7c — path prefix | decided, partial | see below |
| 7d — buildEnv at build time | **not started** | — |
| 8 — verification | done | `Make a deploy that never answered stop counting as a success` |
| 9 — error classification | done | `Stop asking an agent to fix things that are not in the repository` |
| 9 — repair agent context | **not started** | — |

### Decisions taken that the plan left open

- **7c — strip the prefix, or inject it?** Injected, not stripped. `FORCE_SCRIPT_NAME`
  (Django) and `ROOT_PATH` / `APPLICATION_ROOT` (ASGI/Flask) are set when and only
  when a service is mounted under a prefix. The cost of this choice is that a
  service mounted under a prefix whose framework has no mapping still receives the
  prefixed path and must handle it — that case is still a silent 404 and is the
  open half of 7c.
- **Phase 0's two argv shapes.** `deployArgs` emits container-scoped flags only for
  the runner lane and for any lane that has a Cloud SQL sidecar. Naming the
  container of a service last deployed with an unnamed one rewrites a live
  service's container set, so a parity fix must not smuggle in that migration for
  services that were already working.
- **`scale` is not yet authored.** Schema v2 parses it; the pipeline still passes
  `DEFAULT_SCALE` to every lane. Wiring the per-service value through is Phase 3's
  job, since that is where one envelope reaches one executor.
- **assert-consumed reads a `declared` list**, not the resolved values. Every
  resolved field carries a default, so "is it set?" answers yes for a service whose
  author wrote nothing — checking the resolved object would refuse correct configs,
  which is this plan's own bug pointed the other way.

### What the first container-lane deploy found

The app: umami, unmodified except for a `supersonic.json`, one `apk add
postgresql-client` line, and a seed script. Root Dockerfile, so the container
lane; `prisma migrate deploy` plus a half-million-row seed as the `release`
command; a Next.js frontend; `uses: ["database"]`.

Three of the four are the same bug wearing different clothes — **a field that
was written, validated, printed back to the author, and then read by nobody**.
That is the failure this plan is about, and Phase 3 is what ends it structurally.
Until then, each new field costs a call site somewhere, and the ones that get
missed are exactly the ones no lane that already worked would notice.

1. **The container-scoped argv had never been accepted by gcloud.**
   `Exactly one container must specify --port or --use-http2`. `deployArgs`
   emitted `--port` only when a caller passed one, and only the runner lane did.
   So the shape Phase 0 introduced for "container lane, with a database" was
   rejected outright, every time, at the last command of the deploy — after a
   nine-minute build. The parity suite could not have caught it: every assertion
   in it asks what the argv *contains*, and none asked what gcloud would do with
   the whole thing.

2. **The release command was dropped for `language: "other"`.** `plan.preRun` was
   read inside the branch for Node and Python, and tier 3's own spelling takes
   the branch above it. The app deployed, `/api/heartbeat` returned 200 without
   touching Postgres, and every page that read a table was an error — a deploy
   reporting success over a broken app, which is the outcome Phase 8 exists to
   make impossible.

3. **Schema v2's `env` object reached no revision.** Parsed, validated against
   the platform-owned names, listed by `supersonic check`, declared consumable by
   every lane in `LANE_CONSUMES` — and read nowhere.

4. **A failed deploy mints a fresh slug on the next attempt**, because
   `slugForName` excludes `status = 'failed'`. Right when the failure is the
   app's; wrong when it is ours. The first attempt left behind a database, a
   bucket, a per-app role and five secrets that the retry did not reuse, and the
   retry paid for a cold layer cache — a ten-minute build to rediscover the same
   layers. Not fixed here.

What held up, on the same deploy: the proxy sidecar's `/startup` probe passed on
its second attempt and the app connected through it a second later; the per-app
role owned every table 20 Prisma migrations had created, including enough to
TRUNCATE them; the release job ran migrations and a 510,000-row fixture in 117s
against the 1800s task timeout; env, secrets, memory and the deployment facts
all landed on a container-lane revision, which was Phase 0's whole point.

What is still ignored, confirmed live rather than by reading: **`scale`**. The
config declared `cpu: 2`, `timeout: 600`, `maxInstances: 4`; the revision has 1,
900 and 10. That is the Phase 3 item above, and it is the only schema v2 field
left that a deploy accepts and does not act on.

### Known gaps in what landed

- `ResolvedApp` is now read at the END of a deploy, not the start: every field the
  author declared must be visible in the revision that came out, or the deploy
  fails naming it. That closes the ignored-but-present asymmetry as a CLASS —
  three of the four bugs the first container-lane deploy found were instances of
  it, and all three had passing unit tests. What is still open is the executor:
  the lanes continue to reach into the plan, the detector's stack and the config
  for the same facts, so the fields can still disagree on the way in. They can no
  longer disagree on the way out without stopping the deploy.
- The plan's own prescription for this — assert-consumed against a per-lane
  capability list — was implemented and was NOT sufficient. `LANE_CONSUMES` named
  `env` for every lane while no code read it. A capability list is a second
  declaration by the same author as the first, so it agrees with the config and
  both are wrong together. Only the outcome is independent evidence.
- The **release job needs IAM** the control plane may not have:
  `run.jobs.create/update/run` (`roles/run.developer`) plus `actAs` on the app
  runtime service account. Unverified against the live project.
- **`supersonic env set` values do not reach the release job.** Variables set
  directly on the live service are not in a deploy's `extraEnv`, so a migration
  needing one fails naming it. Loud, but a real limit.
- The **per-app Postgres role is best-effort**: it falls back to the shared
  superuser credential and says so. Every fallback is a tenant boundary that did
  not get created, so those log lines are worth watching on the first real deploys.
