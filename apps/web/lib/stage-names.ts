/**
 * The stage names, which are an API rather than labels.
 *
 * Its own module, with NO imports, for one reason: `lib/analytics/attempts.ts` is
 * deliberately pure — its header says so, "kept pure so it can be tested against
 * rows that are awkward on purpose" — and `lib/stages.ts` opens a Postgres pool.
 * Putting the vocabulary in stages.ts would have made the analytics reconstruction
 * depend on a database connection to know the name of a string.
 *
 * WHY ONE LIST AT ALL
 *
 * `deploy_stages` has consumers that hardcode every name, and the table has no
 * CHECK constraint on `stage` — 004 constrains only `outcome`, and `lane`'s
 * constraint is deferred to phase two by 012 — so nothing in the database objects
 * to a typo either. The failure that produces is not an error, it is a number that
 * quietly becomes zero:
 *
 *   - activation is `min(ended_at) FILTER (WHERE stage = 'deploy' AND outcome =
 *     'ok')` with no WHERE and no window (`analytics/queries.ts`), so a renamed
 *     `deploy` makes every app look like it never went live.
 *   - `lane` is taken from the last stage NOT in `LANE_BLIND_STAGES`, so a new
 *     name that should have been blind silently becomes the lane of record.
 *   - `run-record` is what splits rows into deploys at all.
 *
 * This file is what those three read from, so a rename has to move one line and
 * a test rather than be remembered in four places.
 */

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

/**
 * Written inside the pipeline before the lane is chosen.
 *
 * `unpack` is deliberately NOT here even though it is also emitted before the
 * recorder learns the lane. It is charged to "static" on the prebuilt path and to
 * "unknown" on the upload path, and reclassifying it would change what
 * `LANE_BLIND_STAGES` means for rows already in the table.
 *
 * `render` — writing the Dockerfile, the .dockerignore and the base-image digest
 * lookup — is safe to add for the opposite reason: it is a name nothing has ever
 * written, so no historical row changes meaning. Adding a NEW name is free;
 * moving an OLD one rewrites the past. That is the distinction, and it is why
 * `unpack` stays where it is despite belonging here on the merits.
 */
/*
 * `plan` — the planner deciding how this repo gets built — is added on the same
 * grounds `render` was: a name nothing has ever written, so no historical row
 * changes meaning, and lane-blind because it runs before the lane is chosen.
 *
 * It is also the longest unmeasured step left in the pre-lane half. The planner
 * spent 87 seconds on 1 Aug re-deriving `node index.js` for files that had not
 * changed — the fix (a plan cache) shipped, and there was still no column that
 * says whether it hit. `plan` with an `ok` outcome and a duration under a second
 * is a cache hit; nine seconds is the model.
 */
export const PRE_LANE_STAGES = ["clone", "detect", "infer-services", "render", "plan"] as const;

/**
 * Written by a recorder that knows the lane.
 *
 * `fleet` — placing the app on a node and checking it answers from there — is a
 * new name nothing has ever written, so it is free to add by the rule above. It
 * is lane-known rather than lane-blind because whether an app can be placed at
 * all is a property of its lane: `static` has no image and `runner`'s image is
 * not the app's, and those are exactly the two that stay on Cloud Run.
 *
 * `fleet-pull` and `fleet-boot` decompose `fleet` further: how long the NODE
 * spent pulling the image and booting the sandbox, which `fleet`'s own span
 * — placement plus verification, from the control plane's side — never
 * measured at all. docs/research/fleet-deploy-time.md named the combined,
 * unmeasured cost of the two the largest blind spot in the deploy path, and
 * splitting them is the point: a slow registry and a slow sandbox boot have
 * different fixes, and one number covering both would repeat the exact
 * mistake docs/superpowers/specs/2026-08-06-deploy-cold-start-design.md
 * documents making, and unmaking, for `job-cold-start`. New names nothing
 * has written before, so — same as `fleet` itself — free to add.
 *
 * Both are written by lib/fleet.ts's `recordStartTiming`, off the node's own
 * async sync rather than from inside the deploy pipeline, which is also why
 * they are the second example (after `unpack`) of a LANE_KNOWN stage whose
 * writer does not actually know the lane at write time — see
 * `recordStartTiming`'s own comment for why "unknown" is written there on
 * purpose rather than looked up.
 */
export const LANE_KNOWN_STAGES = [
  // `prepare` was the RUNNER's build step — it encrypted the app's code into a
  // bundle for a shared prebuilt image to fetch at start — and it is gone with
  // that lane. Removed rather than left declared, because the test below reads a
  // declared-but-unwritten name as "this never happened" rather than as an
  // emitter somebody deleted, which is the quieter half of the same defect.
  //
  // Rows already written under it are untouched: this list governs what may be
  // WRITTEN, and every query names its stages in SQL.
  // `processes` went the same way as `bundle`, one stage later. It timed
  // `deployProcesses`, which deployed an app's workers and crons to Cloud Run as
  // worker pools and jobs — and by the end deployed nothing at all, passing an
  // empty list so the orphan sweep would DELETE what an app still had there. The
  // node owns those processes now and there is nothing left on Cloud Run to
  // sweep, so the emitter is gone and the name goes with it.
  "unpack", "build", "upload", "release", "deploy", "verify", "repair-agent", "fleet",
  "fleet-pull", "fleet-boot",
] as const;

/** Every stage name this system may write. */
export const ALL_STAGES: readonly string[] = [...HANDOFF_STAGES, ...PRE_LANE_STAGES, ...LANE_KNOWN_STAGES];

/**
 * `fleet-pull` and `fleet-boot` again, named here for what a reader of
 * deploy_stages must NOT do with them rather than for what wrote them.
 *
 * Both are written off the node's own async sync (`recordStartTiming`,
 * lib/fleet.ts) every time it successfully starts a process — a genuine
 * deploy, a crash-loop restart, and a node reboot all look identical from
 * there, and none of the three carries a `run_id`, because the node has no
 * notion of a deploy attempt. A query that reconstructs ONE DEPLOY's span by
 * grouping deploy_stages on `run_id` (or, for rows older than that column, a
 * time window) must exclude these two before doing that grouping: a restart's
 * row, landing in the same null-run_id bucket as the deploy it has nothing to
 * do with, drags that deploy's reconstructed end forward to whenever the
 * restart happened. This is deploy IDENTITY they must stay out of — a
 * per-stage query that just wants "how long did fleet-pull take, across every
 * row" still wants them, unfiltered.
 */
export const NODE_RESTART_STAGES = ["fleet-pull", "fleet-boot"] as const;

/** The stage whose presence means a new deploy began. */
export const ATTEMPT_START_STAGE = "run-record";

/**
 * The stage whose successful end means the app went live.
 *
 * Read by the activation metric and emitted by the pipeline. Both go through this
 * constant so a test can assert they still agree — which is the whole defence,
 * because the query returns a perfectly well-formed null when they do not.
 */
export const ACTIVATION_STAGE = "deploy";
