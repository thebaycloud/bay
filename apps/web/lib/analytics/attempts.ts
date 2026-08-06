/**
 * Turning `deploy_stages` rows back into deploys.
 *
 * The table records one row per stage and has no run id, so "how many deploys
 * were there, and how many worked" is not a column anywhere — it has to be
 * reconstructed. This file is that reconstruction, kept pure so it can be tested
 * against rows that are awkward on purpose rather than only against whatever
 * production happens to hold today.
 *
 * Three facts about how the rows are written drive everything here, and each one
 * is a way to get the answer wrong:
 *
 * 1. **`run-record` starts a deploy.** It is the first thing the API writes for
 *    every deploy that goes through the job (`app/api/deploy/route.ts`), so it is
 *    a real boundary rather than a guessed one. Deploys that predate the job
 *    indirection have no such marker, so a time gap is the fallback.
 *
 * 2. **The repair agent redeploys inside the same deploy.** `repairDeploy` is
 *    handed `runDeploy` itself, so one deploy a person started can write three
 *    `deploy` rows. Counting `deploy` rows counts attempts by the machine, not
 *    deploys by a human, and the two differ by exactly the failures we most want
 *    to know about.
 *
 * 3. **`lane` is a placeholder until the lane is chosen.** The pipeline opens
 *    with `new StageRecorder(slug, "generic")` and replaces it once it knows
 *    (`deploy-pipeline.ts:1216`); the handoff stages hardcode "generic" too. So
 *    "generic" on an early row means "not known yet" and on a later row means
 *    "this app ships a Dockerfile" — the same string for two different facts.
 *    Reading the lane off the wrong row silently files every static deploy under
 *    generic.
 */

import { ATTEMPT_START_STAGE, HANDOFF_STAGES, PRE_LANE_STAGES } from "../stage-names";

export type StageOutcome = "ok" | "failed" | "skipped";

/** A row of `deploy_stages`, as the analytics queries read it. */
export interface RawStage {
  slug: string;
  lane: string;
  stage: string;
  startedAt: Date;
  endedAt: Date | null;
  outcome: StageOutcome | null;
  /** "python3.12". Null on a row written before the lane was known. */
  runtime?: string | null;
  /** The app's first deploy — a guaranteed cache miss. Null for static and when unknown. */
  cold?: boolean | null;
}

/**
 * Stages whose `lane` is not evidence of anything.
 *
 * The four handoff stages are written by `route.ts` and `scripts/deploy-job.ts`
 * with "generic" hardcoded, before a lane exists at all. `clone`, `detect` and
 * `infer-services` run inside the pipeline before the recorder is replaced with
 * one that knows the lane.
 *
 * DERIVED, not restated. This was seven hand-written strings in a file whose own
 * header is about a vocabulary that drifted from the one the pipeline used — the
 * same list written twice is how that happened. `lib/stages.ts` names them once;
 * the membership here is byte-identical to what was written by hand, and
 * `test/stages.test.ts` pins that it stays a subset of the emitted vocabulary.
 */
export const LANE_BLIND_STAGES: ReadonlySet<string> = new Set<string>([
  ...HANDOFF_STAGES,
  ...PRE_LANE_STAGES,
]);

export { ATTEMPT_START_STAGE };

/**
 * Stages that happen *inside* another stage, so their time is already counted.
 *
 * `job-cold-start` is measured from the run row being written to the job process
 * reaching its first line. Two other stages fall entirely within that span:
 * `run-fetch`, measured from this process starting, and `job-dispatch`, which
 * ends when Cloud Run accepts the execution — necessarily before the execution
 * starts running.
 *
 * `run-record` is NOT listed, because it only *partially* overlaps: the run row's
 * created_at is written during it, so `job-cold-start` begins somewhere inside
 * `run-record` rather than after it. Partial overlap is why `coveredMs` unions
 * intervals rather than subtracting a list of known-nested stages — a list can
 * only ever describe the overlaps somebody remembered.
 */
export const NESTED_STAGES: ReadonlyArray<[inner: string, outer: string]> = [
  ["run-fetch", "job-cold-start"],
  ["job-dispatch", "job-cold-start"],
  // Both halves of the split fall entirely within the span they split.
  ["job-launch", "job-cold-start"],
  ["job-import", "job-cold-start"],
];

/**
 * Wall-clock time covered by at least one recorded stage.
 *
 * The union of the intervals, not their sum. Stages overlap in at least three
 * ways here and it is not safe to enumerate them, so the intervals are merged:
 * the result is by construction never greater than the span it is measured
 * over, and what it leaves is genuinely unattributed time rather than an
 * artefact of double counting.
 */
export function coveredMs(stages: RawStage[]): number {
  const spans = stages
    .filter((s) => s.endedAt)
    .map((s) => [s.startedAt.getTime(), s.endedAt!.getTime()] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);

  let total = 0;
  let openFrom = -Infinity;
  let openTo = -Infinity;
  for (const [from, to] of spans) {
    if (from > openTo) {
      if (openTo > openFrom) total += openTo - openFrom;
      openFrom = from;
      openTo = to;
    } else if (to > openTo) {
      openTo = to;
    }
  }
  if (openTo > openFrom) total += openTo - openFrom;
  return total;
}

export type AttemptOutcome = "ok" | "failed" | "unknown";
export type RepairVerdict = "none" | "helped" | "did-not-help";

export interface Attempt {
  slug: string;
  /** The lane it was charged to, or null if it never got as far as choosing one. */
  lane: string | null;
  startedAt: Date;
  /** The end of the last stage that finished, or null if none has. */
  endedAt: Date | null;
  /** Wall-clock across the whole deploy. Null while it is still open. */
  durationMs: number | null;
  outcome: AttemptOutcome;
  /** Whether the pipeline reached the point of deploying anything at all. */
  reachedDeploy: boolean;
  repair: RepairVerdict;
  /** How many times the pipeline pushed a revision — 1, or more if repair retried. */
  deployRounds: number;
  stages: RawStage[];
}

export interface SessionizeOptions {
  /**
   * How long a silence ends a deploy, for rows with no `run-record` to bound
   * them. 30 minutes by default: the longest deploy on record is 27, and the
   * event log's own liveness bound is 15 (`deploys.ts` STALE_AFTER_MS), so this
   * is generous on purpose. Splitting one slow deploy in two would invent a
   * failure that never happened, which is the worse error of the two.
   */
  gapMs?: number;
}

const DEFAULT_GAP_MS = 30 * 60_000;

function endOf(row: RawStage): Date {
  return row.endedAt ?? row.startedAt;
}

/**
 * Group raw stage rows into deploys, newest last.
 *
 * Rows may arrive in any order and from any number of slugs; they are grouped by
 * slug and sorted here, because the caller reading a time window has no reason
 * to guarantee either.
 */
export function sessionizeAttempts(rows: RawStage[], opts: SessionizeOptions = {}): Attempt[] {
  const gapMs = opts.gapMs ?? DEFAULT_GAP_MS;

  const bySlug = new Map<string, RawStage[]>();
  for (const row of rows) {
    const list = bySlug.get(row.slug);
    if (list) list.push(row);
    else bySlug.set(row.slug, [row]);
  }

  const attempts: Attempt[] = [];
  for (const [slug, slugRows] of bySlug) {
    slugRows.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

    let current: RawStage[] = [];
    // The furthest point in time the deploy so far has reached. Not the last
    // row's end: stages nest, so a `run-fetch` row that ends before the
    // `job-cold-start` row containing it must not make the deploy look idle.
    let reachedAt = -Infinity;

    const flush = () => {
      if (current.length) attempts.push(describe(slug, current));
      current = [];
    };

    for (const row of slugRows) {
      const isBoundary = row.stage === ATTEMPT_START_STAGE;
      const isSilent = row.startedAt.getTime() - reachedAt > gapMs;
      if (current.length && (isBoundary || isSilent)) flush();
      current.push(row);
      reachedAt = Math.max(reachedAt, endOf(row).getTime());
    }
    flush();
  }

  attempts.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  return attempts;
}

/** Read one deploy's worth of rows into an answer. */
function describe(slug: string, stages: RawStage[]): Attempt {
  const startedAt = stages[0].startedAt;

  // Every finished stage's end; the deploy ended when the last one did. A deploy
  // with an unfinished stage in it has no end — it either is still running or
  // died without writing one, and both are honestly "we do not know".
  const ends = stages.filter((s) => s.endedAt).map((s) => s.endedAt!.getTime());
  const open = stages.some((s) => !s.endedAt);
  const endedAt = !open && ends.length ? new Date(Math.max(...ends)) : null;

  // The lane, read only off rows that could know it.
  let lane: string | null = null;
  for (const s of stages) {
    if (!LANE_BLIND_STAGES.has(s.stage)) lane = s.lane;
  }

  const deploys = stages.filter((s) => s.stage === "deploy");
  const repairRow = stages.filter((s) => s.stage === "repair-agent").pop();

  // The repair agent gets the last word, because it is the last thing that runs:
  // a deploy it rescued is a success, whatever the `deploy` row before it says.
  // Where it did not run, the final `deploy` round decides. Where the pipeline
  // never deployed at all, a failed stage still tells us it broke — that is the
  // refusal path and the clone/detect failures, which are real failures that
  // never touch a `deploy` row.
  let outcome: AttemptOutcome;
  if (repairRow?.outcome === "ok") outcome = "ok";
  else if (repairRow?.outcome === "failed") outcome = "failed";
  else if (deploys.length) {
    const last = deploys[deploys.length - 1].outcome;
    outcome = last === "ok" ? "ok" : last === "failed" ? "failed" : "unknown";
  } else if (stages.some((s) => s.outcome === "failed")) outcome = "failed";
  else outcome = "unknown";

  const repair: RepairVerdict =
    repairRow?.outcome === "ok" ? "helped" : repairRow ? "did-not-help" : "none";

  return {
    slug,
    lane,
    startedAt,
    endedAt,
    durationMs: endedAt ? endedAt.getTime() - startedAt.getTime() : null,
    outcome,
    reachedDeploy: deploys.length > 0,
    repair,
    deployRounds: deploys.length,
    stages,
  };
}

/** Milliseconds a stage took, or null while it is unfinished. */
export function stageDurationMs(row: RawStage): number | null {
  if (!row.endedAt) return null;
  return row.endedAt.getTime() - row.startedAt.getTime();
}
