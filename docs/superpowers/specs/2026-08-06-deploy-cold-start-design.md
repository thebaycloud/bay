# Delete the half of a deploy that does no work

**Date:** 2026-08-06
**Status:** design, approved for planning
**Baseline recorded here is the thing the work is judged against. Do not edit it later.**

## The finding

Measured from `deploy_stages` on 6 Aug, over the preceding 14 days:

| Lane | Happy-path deploys | p50 total | p90 total | of which `job-cold-start` |
|---|---|---|---|---|
| container | 42 | 208.8 s | 350.6 s | 100.1 s |
| runner | 13 | 193.3 s | 457.0 s | 96.1 s |
| static | 4 | 198.2 s | 234.4 s | 96.8 s |

Across all lanes, happy path: **p50 210.4 s, of which `job-cold-start` p50 is 104.4 s — 50%.**

"Happy path" means: went live, no `repair-agent` stage, no stage with `outcome = 'failed'`.

The 104.4 s figure is measured across **every** deploy that wrote the stage (n = 101), not
only the happy-path ones — a deploy pays the toll whether or not it later succeeds. Every
comparison against it must be computed the same way, or the before and after are different
populations.

`job-cold-start` is written at `apps/web/scripts/deploy-job.ts:67`, measured from the
`deploy_runs` row's `created_at` to the job process reaching that line. It is Cloud Run
scheduling, image pull, container start, Node boot, the `tsx` transpile of the import tree,
and `claimRun`. **No part of it is the user's build.**

### What is exact and what is reconstructed

The 104.4 s is one stage's own duration — a single row's `ended_at - started_at`. It is exact.

The 210.4 s denominator is reconstructed: these rows predate `018_stage_run_id.sql`, so a
deploy had to be rebuilt by splitting each slug's rows at `run-record`, the stage
`lib/stage-names.ts` names as `ATTEMPT_START_STAGE`. Each attempt's end is taken as the last
stage's `ended_at`, never the next attempt's start, so idle time between deploys is not
counted — this does not reproduce the 30-minute-window inflation that `018`'s header
documents. It can still fold in a second deploy that wrote no `run-record`. Treat the
denominator as good to about ±15%, and the numerator as exact.

## Why this and not something else

`docs/superpowers/specs/2026-07-29-deploy-speed-research.md` measured the container lane at
79 s and named a 58-second Cloud Build block as the remaining money. Both of its top
recommendations then landed — BuildKit with `mode=max` (`build` is now p50 33.3 s), and the
fleet, which is that document's "structural option". Neither shows up in the total, because
the handoff into a Cloud Run Job was added afterwards and costs more than either saved.

The fleet is the clearest evidence. Happy-path p50 is 208.8 s with a `fleet` stage and
230.9 s without: three sessions of work worth 22 seconds, because both branches pay the same
104-second entry toll.

This spec does not touch build, fleet, the repair agent, the refactor, or the Go
documentation. Those are separate specs.

## The decomposition, and the gate

Cloud Run's own execution records (six executions, 6 Aug) split the toll:

| Execution | accept → start | → container `Started` | work |
|---|---|---|---|
| sdmgh | 5.6 s | 124.7 s | 80.5 s |
| zfj4x | 12.3 s | 46.2 s | 110.0 s |
| zzndk | 10.9 s | 32.8 s | 106.0 s |
| bw4br | 5.6 s | 51.5 s | 85.6 s |
| t5vsj | 12.9 s | 28.8 s | 73.7 s |
| szm7x | 7.9 s | 93.5 s | 68.7 s |

**Cloud Run scheduling is 5–13 s, not a hundred.** Container-up is 29–125 s. The image is the
control plane's own: **892 MB compressed across 14 layers**, carrying the Next.js build, the
full gcloud SDK plus the `beta` component (`Dockerfile:27`), and both repair engines —
opencode (`Dockerfile:34`) and `@openai/codex` (`Dockerfile:42`).

What these records cannot separate is image pull from Node boot and the `tsx` transpile.
`enteredAt` (`deploy-job.ts:34`) is taken at module load, which in ESM is **after** the
import tree has been resolved and transpiled, so that cost is invisible — lumped in with the
pull, in the one number that decides which fix is the right one.

### Step 0 — the gate

Record `performance.timeOrigin` (process start) alongside `enteredAt`. That yields:

- `created_at → timeOrigin` — scheduling, image pull, container start
- `timeOrigin → enteredAt` — Node boot, `tsx` transpile, import tree
- `enteredAt → claimed` — already recorded as `run-fetch` (p50 3.8 s)

Also recompute the baseline from `run_id` once rows carry it, replacing the reconstructed
210.4 s with an exact figure.

**No thin image is built until this number exists on ~20 deploys.** If the transpile half
dominates, the fix is precompilation and the image is close to irrelevant — different work,
same goal. Building first and measuring after would be a guess dressed as a plan.

## The change, if pull dominates

A second final stage in the **same** `Dockerfile`, from the same build: Node, the compiled
pipeline, git. Out go the Next.js build output, the gcloud SDK and its `beta` component, and
both repair engines.

Removing gcloud is not free — `lib/gcloud.ts` is how the pipeline reaches GCP. The
replacement already exists (`lib/gcp-rest.ts`, 703 lines) and is the July research's second
recommendation, unbuilt. Only the call sites the job's hot path actually uses need to move;
the rest can stay behind the service, which keeps its fat image.

### Where the repair engines go

They run on 21.4% of deploys and cost p50 354 s when they do. A second job with its own image,
invoked only when the pipeline decides to repair: on a path already measured in minutes one
image pull is noise, and it removes two of the three largest layers from **every** deploy.

## Drift, which is the real objection

`deploy-job.ts`'s header states the current guarantee plainly: *"the job and the API are the
same image, so they can never drift."* `cloudbuild.yaml:126` exists to preserve it, and its
comment names the failure — a deploy from main leaving every actual deploy running the
previous commit's pipeline.

This design gives that guarantee up deliberately, so it owes a stronger one. Both images are
built in the same Cloud Build run and tagged with the same `$_TAG`. On top of that,
`startDeployJob` (`lib/deploy-runs.ts:402`) compares the job's image tag against the running
service's revision tag and **refuses to dispatch** when they differ. Silent drift becomes a
loud, immediate failure — which is more than exists today, where the shared image is asserted
by a comment and by nothing else.

## Rollback

One variable, in the shape `BUILDER` already uses. `DEPLOY_JOB_IMAGE` unset means the job runs
the control-plane image exactly as now. Rolling back is deleting a substitution from
`cloudbuild.yaml`, not reverting commits.

## Testing

- Unit: the tag-equality check in `startDeployJob`, both directions — matching tags dispatch,
  differing tags refuse.
- Unit: the three new timing spans are recorded with the right `run_id` and survive a stage
  write failing, since telemetry may never fail a deploy.
- The existing suites stay green: agent 122, apps/web 1136+, CLI 103.
- Verification is not a test. It is `deploy_stages`: 20 deploys after the change, `job-cold-start`
  p50 compared against the 104.4 s recorded above.

## Done means

- `job-cold-start` p50 below **30 s** over at least 20 deploys.
- Deploy success rate no worse than before the change, measured over the same 20.
- The tag check has never refused a dispatch that should have gone through.

## When phase B starts

Three bands, so the middle one is not argued about after the fact:

- **Below 30 s** — done. Phase B is not opened.
- **30–45 s** — the change worked and fell short. Phase B is a judgement call, taken against
  what the next-largest stage costs by then, not automatically.
- **Above 45 s** — the residue is the floor of Cloud Run Job scheduling plus pull, and only a
  warm worker gets past it: a Cloud Run service with `min-instances=1` and `concurrency=1`,
  taking run ids. Phase B opens.

## What this does not claim

At target, a deploy is roughly 135 s. That is not a wow. Underneath the cold start sit `fleet`
(p50 87.7 s) and `deploy` (p50 95.9 s), and reaching a visibly instant deploy means attacking
those next. Separately, `deploy` fails on 92 of 212 recorded attempts and the repair agent
ends `failed` 41 times against 26 `ok` — a reliability problem this spec deliberately leaves
alone, and the stronger candidate for the session after this one.
