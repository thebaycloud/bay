# Instant Deploys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** static deploys in ~15 s first time and ~3 s when the output has not changed,
by building on the user's machine and uploading only the result.

**Architecture:** the CLI ships the same `detectStack` the server uses, runs the
project's own build, hashes the output, skips the upload when that hash is already live,
and otherwise uploads only the output directory. The server verifies the release against
storage before moving the pointer.

**Tech Stack:** Node 22, TypeScript, `node:test` + `tsx`, Next.js 14 App Router, Postgres,
GCS.

## Global Constraints

- Production Postgres: migrations additive and idempotent, never DROP/TRUNCATE/DELETE.
- Tests run with a **quoted** glob: `node --import tsx --test 'test/**/*.test.ts'`.
- A Next.js route file may only export handlers and config — helpers live in `lib/`.
  This broke a production build once already.
- Every optimisation must be able to fail into today's behaviour. A preflight that
  errors, a hash that mismatches, a build that dies: all fall back, none are fatal.
- Verification reads GCS objects directly and must not give the static server any way to
  serve a release other than the live one.
- Never print `AUTH_SECRET`, the Postgres password, `.env.local` or `.pg.json`.

---

### Task 1: Content hash of a directory

**Files:** Create `apps/web/lib/dirhash.ts`, `apps/web/test/dirhash.test.ts`

**Interfaces:** Produces `hashDir(root): Promise<string>`, `hashEntries(entries): string`

- [ ] **Step 1:** Failing tests — same content in a different write order hashes the same;
      renaming a file changes it; changing a byte changes it; nested directories included;
      an empty directory has a stable hash.
- [ ] **Step 2:** Implement: SHA-256 over `path\0bytes` for every file, sorted by path.
- [ ] **Step 3:** Run tests. Commit.

### Task 2: Release verification

**Files:** Create `apps/web/lib/verify-release.ts`, `apps/web/test/verify-release.test.ts`

**Interfaces:** Produces `localReferences(html): string[]`,
`missingFiles(html, present: string[]): string[]`

- [ ] **Step 1:** Failing tests — extracts `src`/`href`; ignores `http://`, `https://`,
      `//cdn`, `data:`, `mailto:`; handles single, double and unquoted attributes and
      self-closing tags; resolves `./x` and `/x` to the same key; reports exactly the
      missing ones.
- [ ] **Step 2:** Implement both as pure functions over strings.
- [ ] **Step 3:** Run tests. Commit.

### Task 3: The prebuilt upload path

**Files:** Modify `apps/web/app/api/deploy/route.ts`;
Create `apps/web/db/005_release_hash.sql`

- [ ] **Step 1:** Migration adding nullable `apps.release_hash`.
- [ ] **Step 2:** On `x-supersonic-prebuilt: 1`, skip detection and building: unpack the
      body, upload to the release prefix, list the objects, verify, then write the
      pointer and the hash together.
- [ ] **Step 3:** Record the stages (`upload`, `verify`) through `StageRecorder`.
- [ ] **Step 4:** Typecheck, build, test. Commit.

### Task 4: Preflight endpoint

**Files:** Create `apps/web/app/api/deploy/preflight/route.ts`

- [ ] **Step 1:** `POST { app, hash }` → resolve the slug for this owner, compare
      `apps.release_hash`, answer `{skip, url}`. Requires a session or CLI token, like
      every other deploy route.
- [ ] **Step 2:** Verify by hand that an unauthenticated call is refused. Commit.

### Task 5: Ship the detector inside the CLI

**Files:** Modify `packages/cli/package.json`, `services/deploy-agent/package.json`;
Create `packages/cli/scripts/bundle-detector.mjs`

- [ ] **Step 1:** Compile `detectStack` to a single JS file into `packages/cli/vendor/`.
- [ ] **Step 2:** Wire it to `prepublishOnly` so a publish cannot ship a stale detector.
- [ ] **Step 3:** Commit.

### Task 6: CLI builds locally

**Files:** Modify `packages/cli/index.js`; Create `packages/cli/test/prebuilt.test.mjs`

- [ ] **Step 1:** Failing tests for the decision function: static with a build command →
      build; container → cloud; no build command → upload as-is; build failure → cloud
      fallback with a reason.
- [ ] **Step 2:** Implement: detect, build, hash, preflight, upload output only.
- [ ] **Step 3:** Warn when the local Node major differs from the detected runtime.
- [ ] **Step 4:** Run tests. Commit.

### Task 7: Dependency cache for the cloud path

**Files:** Modify `apps/web/app/api/deploy/route.ts`

- [ ] **Step 1:** In the static build config, restore `node_modules` from
      `gs://<bucket>/_deps/<lockfile-hash>.tgz` before installing and save it after, both
      best-effort so a cache miss or a failure never fails the build.
- [ ] **Step 2:** Typecheck, build, commit.

### Task 8: End-to-end verification

- [ ] **Step 1:** Deploy a real static project through the CLI, timed.
- [ ] **Step 2:** Redeploy unchanged; confirm the skip and the time.
- [ ] **Step 3:** Break the build locally; confirm the cloud fallback still ships.
- [ ] **Step 4:** Upload a release missing a referenced asset; confirm the pointer does
      not move and the previous release still serves.
- [ ] **Step 5:** Record the measured numbers in the spec. Commit.
