# Deploy cold start — phase 0 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 104-second `job-cold-start` into the two halves that need
different fixes, and make a stale deploy-job image fail loudly instead of silently.

**Architecture:** `job-cold-start` is preserved byte-for-byte — it is the baseline the
spec is judged against. Two new stages are recorded *inside* it: `job-launch` (Cloud
Run scheduling, image pull, container start) and `job-import` (Node boot and the `tsx`
transpile of the import tree). Both are written with a `StageRecorder` whose clock is
frozen at the instant the interval closed, because `end()` stamps "now" and these
intervals closed before the code reporting them ran. Separately, `startDeployJob`
compares the job's image against the running service's and refuses to dispatch on a
mismatch.

**Tech Stack:** TypeScript, Next.js, `node --test` with `tsx`, Postgres, Cloud Run
Admin API over REST.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-06-deploy-cold-start-design.md`. Baseline
  `job-cold-start` p50 **104.4 s** (n = 101, all deploys not just happy path) — never edit it.
- **`job-cold-start`'s definition does not change.** Its `startedAt` stays `createdAt` and
  its end stays the same line. Redefining it destroys the before/after comparison.
- Adding a NEW stage name is free; moving an OLD one rewrites the past
  (`lib/stage-names.ts`). Only new names here.
- Telemetry may never fail a deploy. Every stage write stays inside `StageRecorder`,
  which wraps its own errors.
- All TypeScript work runs from `apps/web`. Test command: `npm test`.
- Never push to `main` — a push deploys production. Commit only.
- Task 4 can refuse a deploy, so it ships with `SKIP_JOB_IMAGE_CHECK=1` as its
  switch-off. Tasks 1–3 are additive telemetry and pure functions and need no rollback.
- This plan stops at the gate. The thin-image / precompile work is a **second plan**,
  written once the numbers from Task 2 exist.

---

### Task 1: Record the two halves of the cold start

**Files:**
- Modify: `apps/web/lib/stage-names.ts:33`
- Modify: `apps/web/lib/analytics/attempts.ts:87-90`
- Modify: `apps/web/scripts/deploy-job.ts:34`, `:63-70`
- Test: `apps/web/test/stages.test.ts` (existing, no edit — it already asserts both directions)

**Interfaces:**
- Consumes: `StageRecorder` from `lib/stages.ts`, constructor
  `(slug, lane, sink?, now?, onError?, facts?)` where `now: () => Date`.
- Produces: stage names `"job-launch"` and `"job-import"` in `HANDOFF_STAGES`, both
  listed in `NESTED_STAGES` as inner stages of `"job-cold-start"`.

- [ ] **Step 1: Add the two names to the vocabulary and watch the existing test go red**

In `apps/web/lib/stage-names.ts`, replace the `HANDOFF_STAGES` declaration:

```ts
/**
 * Written OUTSIDE the pipeline — `app/api/deploy/route.ts` and
 * `scripts/deploy-job.ts` — before a lane exists at all.
 *
 * `job-launch` and `job-import` split `job-cold-start`, which measured 104s p50
 * over the fortnight to 6 Aug — half of a deploy, none of it the user's build.
 * The split is the whole point: `job-launch` is Cloud Run's half (scheduling,
 * image pull, container start) and `job-import` is ours (Node booting and tsx
 * transpiling the import tree). A smaller image fixes the first and a
 * precompiled entry point fixes the second, so which one dominates decides
 * which work is worth doing.
 *
 * `job-cold-start` stays exactly as it was. It is the number the fix is measured
 * against, and a redefined baseline measures nothing.
 */
export const HANDOFF_STAGES = [
  "run-record", "job-dispatch", "job-cold-start", "job-launch", "job-import", "run-fetch",
] as const;
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && node --experimental-test-module-mocks --import tsx --test test/stages.test.ts`

Expected: FAIL on `every stage the vocabulary declares is written by something` —
`"job-launch" is in the vocabulary but nothing writes it`. That test exists because a
declared-but-unwritten name returns zero forever and breaks nothing.

- [ ] **Step 3: Record the two stages from the job**

In `apps/web/scripts/deploy-job.ts`, above the existing `const enteredAt` at line 34:

```ts
/**
 * When this process began, versus when its own code did.
 *
 * `performance.timeOrigin` is process start — BEFORE the import tree at the top
 * of this file was resolved and transpiled by tsx. `enteredAt` is after it. The
 * gap between them is what boot and transpilation cost, and until now it was
 * invisible: `enteredAt` is taken at module load, which in ESM runs after the
 * imports, so that cost sat inside `job-cold-start` indistinguishable from the
 * image pull.
 */
const startedAt = new Date(performance.timeOrigin);
const enteredAt = new Date();
```

Then in `main()`, extend the existing `if (createdAt)` block. Keep the two existing
`cold.end` calls untouched and add below them:

```ts
    // Cloud Run's half: scheduling, image pull, container start. It ended the
    // instant this process existed, which is before the line reporting it runs —
    // so it is written by a recorder whose clock is frozen there, rather than by
    // `cold`, whose `end` stamps the current time.
    const atStart = new StageRecorder(request.slug, "unknown", undefined, () => startedAt, undefined, { runId });
    await atStart.end({ stage: "job-launch", startedAt: createdAt }, "ok");

    // Our half: Node booting and tsx transpiling the import tree above.
    const atEntry = new StageRecorder(request.slug, "unknown", undefined, () => enteredAt, undefined, { runId });
    await atEntry.end({ stage: "job-import", startedAt }, "ok");
```

- [ ] **Step 4: Declare the nesting so analytics does not double count**

In `apps/web/lib/analytics/attempts.ts`, extend `NESTED_STAGES`:

```ts
export const NESTED_STAGES: ReadonlyArray<[inner: string, outer: string]> = [
  ["run-fetch", "job-cold-start"],
  ["job-dispatch", "job-cold-start"],
  // Both halves of the split fall entirely within the span they split.
  ["job-launch", "job-cold-start"],
  ["job-import", "job-cold-start"],
];
```

- [ ] **Step 5: Run the full suite**

Run: `cd apps/web && npm test`

Expected: PASS. `LANE_BLIND_STAGES` is spread from `HANDOFF_STAGES`
(`attempts.ts:66`), so the assertion at `test/stages.test.ts:124` follows automatically.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/stage-names.ts apps/web/lib/analytics/attempts.ts apps/web/scripts/deploy-job.ts
git commit -m "web: split the cold start into Cloud Run's half and ours

job-cold-start is p50 104s, half of a deploy, and none of it is the user's
build. It is also one number covering two problems with different fixes:
Cloud Run scheduling and pulling an 892MB image, then Node booting and tsx
transpiling the import tree.

The second half was invisible rather than small. enteredAt is taken at
module load, which in ESM runs after the imports have been resolved and
transpiled, so that cost was already spent by the time anything measured.
performance.timeOrigin is process start and sits before it.

Both are recorded with a recorder whose clock is frozen at the instant the
interval closed, because end() stamps the current time and these closed
before the code reporting them ran.

job-cold-start itself is untouched. It is the baseline the fix is judged
against, and a redefined baseline measures nothing."
```

---

### Task 2: A committed baseline script, so before and after are the same query

**Files:**
- Create: `apps/web/scripts/deploy-timing.ts`
- Test: none — see Step 1 for why

**Interfaces:**
- Consumes: `getPool` from `lib/db.ts`, database `supersonic_platform`.
- Produces: `npm run timing` printing per-stage percentiles and per-deploy totals.

- [ ] **Step 1: Understand why this has no unit test**

This is a read-only reporting script over production data. Its correctness is not a
property of the code — it is whether the SQL bounds a deploy the way the schema says.
A unit test over fixtures would assert that the script agrees with fixtures somebody
wrote to match it. What makes it trustworthy is that the same file produces the before
number and the after number, so any error in it cancels. Committing it *is* the control.

- [ ] **Step 2: Write the script**

Create `apps/web/scripts/deploy-timing.ts`:

```ts
/**
 * Where deploy time goes, from `deploy_stages`.
 *
 * Committed rather than run ad hoc so the before and after numbers come from
 * identical SQL. Any error in it is then present on both sides and cancels;
 * a query retyped from memory a fortnight later is a different measurement
 * wearing the same name.
 *
 * Run: npm run timing [days]   (defaults to 14)
 */
import { getPool } from "@/lib/db";
import { ATTEMPT_START_STAGE } from "@/lib/stage-names";

const DB = "supersonic_platform";
const days = Number(process.argv[2] || 14);

/**
 * One deploy's rows.
 *
 * `run_id` is the real answer and 018 added it, but every row written before
 * that has none. The fallback splits a slug's rows at each ATTEMPT_START_STAGE,
 * which is what that stage is for. It does NOT extend an attempt to the start of
 * the next one — the end is the last stage's own end — so idle time between
 * deploys is never counted, unlike the thirty-minute window 018 replaced.
 */
const ATTEMPTS = `
  WITH marked AS (
    SELECT *,
      COALESCE(run_id, 'w:' || slug || ':' || sum(CASE WHEN stage = '${ATTEMPT_START_STAGE}' THEN 1 ELSE 0 END)
        OVER (PARTITION BY slug ORDER BY started_at ROWS UNBOUNDED PRECEDING)) AS deploy_key
    FROM deploy_stages WHERE started_at > now() - ($1 || ' days')::interval),
  att AS (
    SELECT deploy_key, min(started_at) AS t0, max(COALESCE(ended_at, started_at)) AS t1,
      bool_or(stage = 'repair-agent') AS had_repair,
      bool_or(outcome = 'failed') AS had_failure,
      bool_or(stage = 'deploy' AND outcome = 'ok') AS went_live,
      (array_agg(lane ORDER BY started_at DESC) FILTER (WHERE lane <> 'unknown'))[1] AS lane
    FROM marked GROUP BY deploy_key)`;

async function main() {
  const pool = getPool(DB);
  const show = async (label: string, sql: string) => {
    const { rows } = await pool.query(sql, [days]);
    console.log(`\n### ${label}`);
    rows.length ? console.table(rows) : console.log("(no rows)");
  };

  // Every deploy that wrote the stage, happy path or not — this is how the
  // 104.4s baseline in the spec was computed, and the comparison must match it.
  await show("Stage durations, all deploys", `
    SELECT stage, count(*) AS n,
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM ended_at-started_at)))::numeric,1) AS p50_s,
      round((percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM ended_at-started_at)))::numeric,1) AS p90_s
    FROM deploy_stages
    WHERE started_at > now() - ($1 || ' days')::interval AND ended_at IS NOT NULL
    GROUP BY stage HAVING count(*) > 1 ORDER BY p50_s DESC`);

  await show("Per-deploy total, happy path only", `${ATTEMPTS}
    SELECT COALESCE(lane,'(none)') AS lane, count(*) AS deploys,
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM t1-t0)))::numeric,1) AS p50_s,
      round((percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM t1-t0)))::numeric,1) AS p90_s
    FROM att WHERE went_live AND NOT had_repair AND NOT had_failure
    GROUP BY 1 ORDER BY deploys DESC`);

  await show("How many deploys carry a real run id yet", `
    SELECT count(*) FILTER (WHERE run_id IS NOT NULL) AS with_run_id,
      count(*) FILTER (WHERE run_id IS NULL) AS reconstructed
    FROM deploy_stages WHERE started_at > now() - ($1 || ' days')::interval`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Add the script entry**

In `apps/web/package.json`, add to `scripts`:

```json
"timing": "node --import tsx scripts/deploy-timing.ts"
```

- [ ] **Step 4: Run it against production and record the baseline**

Start the tunnel, then run it:

```bash
cloud-sql-proxy -g --port 5433 supersonic-deploy-prod:us-central1:supersonic-shared-pg &
cd apps/web && npm run timing
```

Expected: a `job-cold-start` p50 near 104 s, and `job-launch` / `job-import` absent
(nothing has deployed since Task 1 landed). Kill the tunnel afterwards: `pkill -f cloud-sql-proxy`.

- [ ] **Step 5: Verify the suite is unaffected**

Run: `cd apps/web && npm test`

Expected: PASS. This task adds no library code.

- [ ] **Step 6: Commit**

```bash
git add apps/web/scripts/deploy-timing.ts apps/web/package.json
git commit -m "web: commit the query the deploy numbers come from

The before and after of a speed change have to come from identical SQL or
they are two measurements sharing a name. Committing it makes any error in
the query cancel between the two rather than move the result.

Prefers run_id, which 018 added, and falls back to splitting a slug's rows
at run-record for every row written before it. The fallback ends an attempt
at its own last stage rather than at the next attempt's start, so idle time
between deploys is never counted."
```

---

### Task 3: Read a Cloud Run job's image over REST

**Files:**
- Modify: `apps/web/lib/gcp-rest.ts` (add beside `runServiceUrl` at :141)
- Test: `apps/web/test/gcp-rest.test.ts` (existing file; add cases)

**Interfaces:**
- Consumes: `PROJECT`, `REGION` module constants already in `gcp-rest.ts`.
- Produces: `runJobUrl(job: string, project?: string, region?: string): string` and
  `imageTag(image: string): string`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/test/gcp-rest.test.ts`:

```ts
test("runJobUrl targets the Cloud Run Admin v2 jobs resource", () => {
  const url = runJobUrl("supersonic-deploy-job", "proj", "us-central1");
  assert.equal(url, "https://us-central1-run.googleapis.com/v2/projects/proj/locations/us-central1/jobs/supersonic-deploy-job");
});

test("imageTag takes the tag after the last colon, not one inside the host", () => {
  // The registry host may carry a port, and the repository path may not. Splitting
  // on the first colon would read "5000/supersonic/control-plane" as a tag.
  assert.equal(imageTag("us-central1-docker.pkg.dev/p/supersonic/control-plane:abc123"), "abc123");
  assert.equal(imageTag("localhost:5000/supersonic/control-plane:abc123"), "abc123");
});

test("imageTag returns empty for an untagged reference rather than guessing", () => {
  // A digest-pinned or bare reference has no tag. Returning "" makes the caller's
  // comparison fail loudly; inventing "latest" would make two different images
  // compare equal.
  assert.equal(imageTag("us-central1-docker.pkg.dev/p/supersonic/control-plane"), "");
  assert.equal(imageTag("us-central1-docker.pkg.dev/p/supersonic/control-plane@sha256:dead"), "");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && node --experimental-test-module-mocks --import tsx --test test/gcp-rest.test.ts`

Expected: FAIL — `runJobUrl is not defined`.

- [ ] **Step 3: Implement**

Add to `apps/web/lib/gcp-rest.ts`, beside `runServiceUrl`:

```ts
/**
 * A Cloud Run **job**, on the v2 Admin API.
 *
 * Not the Knative v1 path `runServiceUrl` uses: jobs were never part of the
 * Knative surface, and v1 answers 404 for them — which reads as "no such job"
 * rather than "wrong API", and is exactly the kind of wrong answer that gets
 * believed.
 */
export function runJobUrl(job: string, project: string = PROJECT, region: string = REGION): string {
  return `https://${region}-run.googleapis.com/v2/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/jobs/${encodeURIComponent(job)}`;
}

/**
 * The tag of an image reference, or "" when it carries none.
 *
 * Split at the LAST colon, and only when it comes after the last slash: a
 * registry host may carry a port, so the first colon can belong to
 * `localhost:5000/…`. An untagged or digest-pinned reference returns "" rather
 * than the conventional "latest" — the caller compares two of these for
 * equality, and a guess that makes two different images compare equal defeats
 * the comparison.
 */
export function imageTag(image: string): string {
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  return colon > slash ? image.slice(colon + 1) : "";
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/web && node --experimental-test-module-mocks --import tsx --test test/gcp-rest.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/gcp-rest.ts apps/web/test/gcp-rest.test.ts
git commit -m "web: read a Cloud Run job's image over REST

Jobs are not on the Knative v1 surface runServiceUrl uses — v1 answers 404
for them, which reads as \"no such job\" rather than \"wrong API\".

imageTag splits at the last colon after the last slash, because a registry
host may carry a port. An untagged reference returns empty rather than the
conventional latest: the caller compares two of these for equality, and a
guess that makes two different images compare equal defeats the check."
```

---

### Task 4: Refuse to dispatch a deploy to a stale job image

**Files:**
- Modify: `apps/web/lib/deploy-runs.ts:402` (`startDeployJob`)
- Create: `apps/web/test/deploy-runs.test.ts` — `lib/deploy-runs.ts` has no test file of
  its own today; `test/deploy-source-object.test.ts` is the only file that mentions it.

**Interfaces:**
- Consumes: `runJobUrl`, `imageTag`, `accessToken` from `lib/gcp-rest.ts`.
- Produces: `assertJobImageMatches(job: string, deps?: ImageProbe): Promise<void>`, exported
  for tests, where
  `type ImageProbe = { jobImage: () => Promise<string>; serviceImage: () => Promise<string> }`.
  Throws `Error` on mismatch. `startDeployJob` awaits it before dispatching.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/deploy-runs.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertJobImageMatches } from "../lib/deploy-runs";

test("dispatch is allowed when the job and the service run the same tag", async () => {
  await assert.doesNotReject(() => assertJobImageMatches("supersonic-deploy-job", {
    jobImage: async () => "reg/supersonic/control-plane:abc123",
    serviceImage: async () => "reg/supersonic/control-plane:abc123",
  }));
});

test("dispatch is refused when the job is on an older tag", async () => {
  // cloudbuild.yaml's job step ends in `|| echo`, so a failed job update never
  // fails the build. The job is then left on the previous commit's pipeline
  // while the service moves — every deploy runs code nobody thinks is running.
  await assert.rejects(
    () => assertJobImageMatches("supersonic-deploy-job", {
      jobImage: async () => "reg/supersonic/control-plane:old111",
      serviceImage: async () => "reg/supersonic/control-plane:new222",
    }),
    /old111.*new222|new222.*old111/,
  );
});

test("dispatch is refused when either image carries no tag", async () => {
  // Two untagged references both read as "" and would compare equal, which is
  // the one case where equality is not evidence of agreement.
  await assert.rejects(
    () => assertJobImageMatches("supersonic-deploy-job", {
      jobImage: async () => "reg/supersonic/control-plane",
      serviceImage: async () => "reg/supersonic/control-plane",
    }),
    /untagged/,
  );
});

test("a probe that cannot answer does not block the deploy", async () => {
  // The check exists to catch a stale image, not to become a new way for every
  // deploy to fail. An API that is down must cost the check, not the deploy.
  await assert.doesNotReject(() => assertJobImageMatches("supersonic-deploy-job", {
    jobImage: async () => { throw new Error("500 from Cloud Run"); },
    serviceImage: async () => "reg/supersonic/control-plane:abc123",
  }));
});

test("SKIP_JOB_IMAGE_CHECK=1 turns the refusal off without a deploy", async () => {
  // A guard that can refuse every deploy needs a way to be switched off that is
  // faster than shipping a revert — the same shape BUILDER already uses, and the
  // reason cloudbuild.yaml keeps its lane flags as variables.
  process.env.SKIP_JOB_IMAGE_CHECK = "1";
  try {
    await assert.doesNotReject(() => assertJobImageMatches("supersonic-deploy-job", {
      jobImage: async () => "reg/supersonic/control-plane:old111",
      serviceImage: async () => "reg/supersonic/control-plane:new222",
    }));
  } finally {
    delete process.env.SKIP_JOB_IMAGE_CHECK;
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && node --experimental-test-module-mocks --import tsx --test test/deploy-runs.test.ts`

Expected: FAIL — `assertJobImageMatches is not defined`.

- [ ] **Step 3: Implement**

Add to `apps/web/lib/deploy-runs.ts`, above `startDeployJob`:

```ts
/**
 * Where the two images come from. Injected so the check can be tested without
 * reaching Cloud Run.
 */
export interface ImageProbe {
  jobImage: () => Promise<string>;
  serviceImage: () => Promise<string>;
}

async function fetchImage(url: string, pick: (body: any) => string | undefined): Promise<string> {
  const token = await accessToken();
  if (!token) throw new Error("no access token");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return pick(await res.json()) ?? "";
}

const liveProbe: ImageProbe = {
  jobImage: () => fetchImage(
    runJobUrl(process.env.DEPLOY_JOB_NAME || "supersonic-deploy-job"),
    (b) => b?.template?.template?.containers?.[0]?.image),
  serviceImage: () => fetchImage(
    runServiceUrl(process.env.K_SERVICE || "supersonic-control-plane"),
    (b) => b?.spec?.template?.spec?.containers?.[0]?.image),
};

/**
 * Refuse to hand a deploy to a job running different code from this service.
 *
 * `scripts/deploy-job.ts` states the guarantee this replaces: "the job and the
 * API are the same image, so they can never drift." Nothing enforced it.
 * `cloudbuild.yaml:126` updates the job and ends in `|| echo`, so a failed
 * update never fails the build — the job keeps the previous commit's pipeline
 * while the service moves, and every deploy runs code nobody believes is
 * running. That is the worst kind of drift, because the thing that looks
 * deployed is not the thing doing the work.
 *
 * A probe that cannot answer does NOT block the deploy. The check exists to
 * catch a stale image, not to become a fresh way for every deploy to fail when
 * an API is having a bad minute.
 */
export async function assertJobImageMatches(job: string, deps: ImageProbe = liveProbe): Promise<void> {
  // The switch-off, in the shape BUILDER and the other lane flags already use. A
  // guard that can refuse every deploy has to be removable in one variable
  // rather than in a revert and a build.
  if (process.env.SKIP_JOB_IMAGE_CHECK === "1") return;
  let jobRef: string, serviceRef: string;
  try {
    [jobRef, serviceRef] = await Promise.all([deps.jobImage(), deps.serviceImage()]);
  } catch (e) {
    console.error(`could not compare ${job}'s image against this service's`, e);
    return;
  }
  const a = imageTag(jobRef), b = imageTag(serviceRef);
  if (!a || !b) {
    throw new Error(`refusing to deploy: an untagged image (job "${jobRef}", service "${serviceRef}") cannot be compared`);
  }
  if (a !== b) {
    throw new Error(`refusing to deploy: ${job} runs image tag ${a} but this service runs ${b} — the job was not updated by the last deploy of main`);
  }
}
```

Add the imports at the top of `deploy-runs.ts`:

```ts
import { accessToken, imageTag, runJobUrl, runServiceUrl } from "./gcp-rest";
```

Then make `startDeployJob` await it. Change its body's first statement:

```ts
export async function startDeployJob(runId: string, region: string, job: string): Promise<void> {
  await assertJobImageMatches(job);
  return gcloud([
```

(the rest of the function is unchanged; note the signature already returns a Promise, and
the `route.ts:259` call site already awaits it, so no caller changes).

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/web && node --experimental-test-module-mocks --import tsx --test test/deploy-runs.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `cd apps/web && npm test`

Expected: PASS. `app/api/deploy/route.ts:265` already catches a throw from
`startDeployJob`, deletes the run row and answers 503 with the message — so a refusal
surfaces to the user as an immediate, honest failure rather than a deploy that never
happens.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/deploy-runs.ts apps/web/test/deploy-runs.test.ts
git commit -m "web: refuse to hand a deploy to a job running other code

deploy-job.ts states the guarantee: the job and the API are the same image,
so they can never drift. Nothing enforced it. cloudbuild.yaml's job step
ends in || echo so a failed update never fails the build, which leaves the
job on the previous commit's pipeline while the service moves — the worst
kind of drift, because the thing that looks deployed is not the thing doing
the work.

Untagged references are refused rather than compared. Two of them both read
as empty and would compare equal, which is the one case where equality is
not evidence of agreement.

A probe that cannot answer does not block the deploy. This exists to catch a
stale image, not to become a fresh way for every deploy to fail when an API
is having a bad minute. SKIP_JOB_IMAGE_CHECK=1 switches it off entirely, in
the shape the lane flags already use: a guard that can refuse every deploy
has to be removable in one variable rather than in a revert and a build."
```

---

## The gate

Tasks 1–4 land, `main` is deployed, and **twenty deploys pass through**. Then:

```bash
cloud-sql-proxy -g --port 5433 supersonic-deploy-prod:us-central1:supersonic-shared-pg &
cd apps/web && npm run timing
```

Read `job-launch` p50 against `job-import` p50, and pick the branch the spec sets out:

- **`job-launch` dominates** → the fix is the image: a second final stage in the same
  `Dockerfile` without the Next.js build, the gcloud SDK, or the two repair engines,
  with the engines moving to their own job.
- **`job-import` dominates** → the fix is precompilation: build the job's entry point to
  plain JS and drop `tsx` from its command. The image barely matters.
- **Neither dominates** → both, image first, since it is the larger absolute number in
  the 6 Aug execution records.

**Write that as its own plan.** It is not written here on purpose: which branch is real
is exactly what these four tasks exist to find out, and a plan for both is a plan for the
one that turns out to be wrong.
