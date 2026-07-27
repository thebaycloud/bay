# Fast Deploys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** split the deploy pipeline into three lanes so a first deploy of a static app
finishes in 30-45 s instead of ~2 minutes, and every lane gets shared caching.

**Architecture:** the detector labels each project `static` or `container`. Static projects
build their assets and upload them to GCS, served by one shared Cloud Run service that
resolves the slug from the `Host` header. Container projects build over prebuilt regional
base images. All lanes share a regional npm mirror, concurrent provisioning, and one clone.

**Tech Stack:** Node 22, TypeScript, `node:test` + `tsx`, Next.js 14 App Router, Postgres,
Cloud Run, Cloud Build, GCS, Artifact Registry.

## Global Constraints

- The shared Postgres instance is **production**. Migrations are additive and idempotent —
  never DROP, TRUNCATE or DELETE existing rows.
- Tests run with a **quoted** glob: `node --import tsx --test 'test/**/*.test.ts'`.
  An unquoted `--test test/` silently passes without running anything on Node 22.
- A project containing its own `Dockerfile` always takes the container lane.
- No new long-lived process may execute customer build scripts. Builds stay in Cloud Build.
- New service accounts get least privilege at creation, never "fix it later".
- Never print `AUTH_SECRET`, the Postgres password, `.env.local` or `.pg.json`.
- GCP resource creation (buckets, Artifact Registry repos, service accounts) and any
  `gcloud run deploy` are left to a human — code lands first, infra is applied separately.

---

### Task 1: Per-stage deploy telemetry

Ships first: it is how every later claim in this plan gets checked.

**Files:**
- Create: `apps/web/db/003_deploy_stages.sql`
- Create: `apps/web/lib/stages.ts`
- Test: `apps/web/test/stages.test.ts`
- Modify: `apps/web/app/api/deploy/route.ts`

**Interfaces:**
- Produces: `startStage(slug, lane, name): StageHandle`, `endStage(h, outcome)`,
  `recordStage(slug, lane, name, startedAt, endedAt, outcome)`.

- [ ] **Step 1: Write the migration** — table `deploy_stages(id, slug, lane, stage,
      started_at, ended_at, outcome)`, `CREATE TABLE IF NOT EXISTS`, index on `(slug, started_at)`.
- [ ] **Step 2: Write failing tests** for stage duration maths and for the recorder
      swallowing database errors (telemetry must never fail a deploy).
- [ ] **Step 3: Implement `lib/stages.ts`.**
- [ ] **Step 4: Run tests, then wire the recorder around each pipeline stage.**
- [ ] **Step 5: Commit.**

### Task 2: Detector reports the serving mode

**Files:**
- Modify: `services/deploy-agent/src/index.ts`
- Create: `services/deploy-agent/test/serve.test.ts`

**Interfaces:**
- Produces: `Stack.serve: { mode: "static"; outputDir: string } | { mode: "container" }`

Rules — Vite and Create React App are static; Astro is static only without an SSR adapter;
Next.js is static only with `output: 'export'`; SvelteKit, Nuxt, Remix and NestJS are
container; a bare `index.html` with no manifest is static.

- [ ] **Step 1: Write failing tests** covering each rule plus both Astro branches.
- [ ] **Step 2: Add the field and the rules.**
- [ ] **Step 3: Run tests. Commit.**

### Task 3: Static file server

**Files:**
- Create: `services/static/src/{server,resolve,paths,pointer}.ts`, `package.json`, `Dockerfile`
- Test: `services/static/src/*.test.ts`

**Interfaces:**
- Produces: `slugFromHost(host)`, `resolveObject(slug, urlPath, release)`,
  `cacheHeadersFor(path)`, `readPointer(slug)`.

- [ ] **Step 1: Write failing tests** — extensionless miss serves `index.html` 200; a miss
      *with* an extension is 404; `..` and encoded traversal are rejected; hashed asset names
      get `immutable`, `index.html` gets `no-cache`; an unknown host is 404.
- [ ] **Step 2: Implement the pure modules, then the server.**
- [ ] **Step 3: Run tests. Commit.**

### Task 4: Static lane in the deploy route

**Files:**
- Modify: `apps/web/app/api/deploy/route.ts`
- Create: `apps/web/lib/static-release.ts`
- Test: `apps/web/test/static-release.test.ts`

Build with Cloud Build, upload the output directory to
`gs://supersonic-static-assets/<slug>/r/<release-id>/`, then write `<slug>/current`.
The pointer is written **last** so a failed upload leaves the live site untouched.

- [ ] **Step 1: Write failing tests** for release-id generation and pointer ordering.
- [ ] **Step 2: Implement, branch on `stack.serve.mode`, keep the container path untouched.**
- [ ] **Step 3: Run tests. Commit.**

### Task 5: Concurrent provisioning and a single clone

**Files:**
- Modify: `apps/web/app/api/deploy/route.ts`, `apps/web/app/api/detect/route.ts`
- Create: `apps/web/lib/clone-cache.ts`
- Test: `apps/web/test/clone-cache.test.ts`

- [ ] **Step 1: Write failing tests** — a token miss returns null rather than throwing; entries
      expire; a token cannot escape the cache root.
- [ ] **Step 2: Implement the cache; `/api/detect` returns a token, `/api/deploy` reuses it.**
- [ ] **Step 3: Run database and bucket provisioning concurrently with the build.**
- [ ] **Step 4: Run tests. Commit.**

### Task 6: Regional npm mirror and build flags

**Files:**
- Modify: `apps/web/app/api/deploy/route.ts`

- [ ] **Step 1: Add `--prefer-offline --no-audit --no-fund` to generated install commands.**
- [ ] **Step 2: Point generated Dockerfiles at the mirror when `NPM_REGISTRY` is set,
      leaving the default registry when it is not.**
- [ ] **Step 3: Typecheck, build, commit.**

### Task 7: Base images with a promotion gate

**Files:**
- Create: `infra/bases/{node22,node22-next,python312-uvicorn}/Dockerfile`
- Create: `infra/bases/refresh.sh`

`refresh.sh` builds `:candidate`, runs a real test deploy through it, and only then retags
`:stable`. A failed test leaves `:stable` alone.

- [ ] **Step 1: Write the base Dockerfiles with a pre-populated package cache.**
- [ ] **Step 2: Write `refresh.sh` with the promotion gate.**
- [ ] **Step 3: Make the fast lane fall back to the generic lane when a base is unpullable.**
- [ ] **Step 4: Commit.**

### Task 8: Infrastructure notes for a human

**Files:**
- Modify: `docs/CUTOVER.md`

- [ ] **Step 1: Document creating the bucket, the mirror, the base repo, the static service
      account with `objectViewer` scoped to one bucket, and deploying `supersonic-static`.**
- [ ] **Step 2: Commit.**
