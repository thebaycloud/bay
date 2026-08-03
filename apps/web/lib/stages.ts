import { getPool } from "./db";
import { ALL_LANES, type Lane } from "./lanes";

const DB = "supersonic_platform";

/**
 * The lane a stage is charged to, PLUS the honest answer before one is chosen.
 *
 * This module used to export its own `export type Lane = "static" | "fast" |
 * "generic" | "runner"` — a second exported type with the same NAME as the one in
 * lib/lanes.ts, overlapping on two values and disagreeing on the other two. The
 * deploy executed `container` and `buildpack`; the database recorded `generic`
 * and `fast`. TypeScript cannot catch that (separate declarations) and the column
 * was `text NOT NULL`, so neither could Postgres — which is why `deploy_stages`
 * has been collecting data since 004 while the question it was created to answer
 * could not be computed from it.
 *
 * `unknown` is the fix for the worse half. `generic` was ALSO what the pipeline
 * recorded before it knew the lane, so one string meant "not decided yet" on one
 * row and "this app ships a Dockerfile" on another, and lib/analytics/attempts.ts
 * had to carry LANE_BLIND_STAGES to work around it. A value that says "not known"
 * makes that workaround a fallback rather than the mechanism.
 *
 * A first-class value rather than null: a stage recorded before the lane was
 * chosen is a fact, and null would make it indistinguishable from a failure to
 * record one.
 */
export type StageLane = Lane | "unknown";

/**
 * `StageLane` as values, and the single source for what the column may hold.
 *
 * `db/011_stage_lane_vocabulary.sql` constrains the column to exactly these, and
 * test/stages.test.ts reads the migration and compares. That pairing is the
 * actual fix: the reason two vocabularies could coexist is that nothing anywhere
 * asserted they were the same set.
 */
export const STAGE_LANES: StageLane[] = ["unknown", ...ALL_LANES];
export type Outcome = "ok" | "failed" | "skipped";

/**
 * The stage vocabulary lives in `lib/stage-names.ts`, which imports nothing.
 *
 * Re-exported here so a caller that already has the recorder does not need a
 * second import, and kept OUT of this file because analytics/attempts.ts needs the
 * names and must not acquire a Postgres pool to read a string.
 */
export {
  HANDOFF_STAGES, PRE_LANE_STAGES, LANE_KNOWN_STAGES, ALL_STAGES,
  ATTEMPT_START_STAGE, ACTIVATION_STAGE,
} from "./stage-names";

export interface StageRow {
  slug: string;
  lane: StageLane;
  stage: string;
  startedAt: Date;
  endedAt: Date | null;
  outcome: Outcome | null;
  /** What the app ran on — "python3.12". Null until the detector or config says. */
  runtime?: string | null;
  /** Whether this was the app's first successful deploy. Null when not yet known. */
  cold?: boolean | null;
}

/** Where a stage's timings are written. Swapped out in tests. */
export interface StageSink {
  write(row: StageRow): Promise<void>;
}

export const postgresSink: StageSink = {
  async write(row) {
    await getPool(DB).query(
      `INSERT INTO deploy_stages (slug, lane, stage, started_at, ended_at, outcome, runtime, cold)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [row.slug, row.lane, row.stage, row.startedAt, row.endedAt, row.outcome, row.runtime ?? null, row.cold ?? null],
    );
  },
};

export interface StageHandle {
  readonly stage: string;
  readonly startedAt: Date;
}

/**
 * Records how long each part of a deploy took.
 *
 * Telemetry must never be the reason a deploy fails, so every write is wrapped:
 * a broken sink costs us the measurement and nothing else. That is the single
 * most important property of this class and the reason it has its own tests.
 */
export class StageRecorder {
  constructor(
    private readonly slug: string,
    private readonly lane: StageLane,
    private readonly sink: StageSink = postgresSink,
    private readonly now: () => Date = () => new Date(),
    private readonly onError: (e: unknown) => void = (e) => console.error("stage write failed", e),
    /**
     * What the app runs on, and whether this is its first successful deploy.
     *
     * Carried on the recorder rather than passed per stage because both are facts
     * about the DEPLOY, not about the stage — and because the caller learns them
     * at the same moment it learns the lane, which is the moment it replaces the
     * recorder. Optional so every existing construction site keeps compiling and
     * keeps meaning exactly what it meant.
     *
     * "Measure what the runner cache buys before deleting the lane" has now been
     * written into three plans with no column to compute it from. These are that
     * column: the lane says which build path ran, `runtime` says whether the
     * deploys taking it are the two languages the runner supports or the long
     * tail it does not, and `cold` says whether a cache could have been hit at
     * all. A first deploy is a guaranteed miss and is also the moment the product
     * is judged.
     */
    private readonly facts: { runtime?: string | null; cold?: boolean | null } = {},
  ) {}

  start(stage: string): StageHandle {
    return { stage, startedAt: this.now() };
  }

  /**
   * The last stage that ended in failure, or null.
   *
   * Kept here because this class is the only thing that already sees every stage
   * boundary — the alternative is a `let currentStage` in runDeploy that every
   * one of its twenty-odd `around` calls has to remember to update, which is the
   * kind of bookkeeping that is correct on the day it is written.
   *
   * Part 5 is what needs it: `classify` had to infer platform-versus-app blame
   * from the wording of an error, because where the failure happened was not
   * recorded anywhere it could reach. "The build failed" and "the deploy failed"
   * want different default blame, and that is a fact rather than a guess.
   */
  private lastFailure: string | null = null;

  failedStage(): string | null {
    return this.lastFailure;
  }

  async end(handle: StageHandle, outcome: Outcome): Promise<void> {
    if (outcome === "failed") this.lastFailure = handle.stage;
    try {
      await this.sink.write({
        slug: this.slug,
        lane: this.lane,
        stage: handle.stage,
        startedAt: handle.startedAt,
        endedAt: this.now(),
        outcome,
        runtime: this.facts.runtime ?? null,
        cold: this.facts.cold ?? null,
      });
    } catch (e) {
      this.onError(e);
    }
  }

  /** Time an operation, recording it whichever way it goes, then rethrow on failure. */
  async around<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    const h = this.start(stage);
    try {
      const out = await fn();
      await this.end(h, "ok");
      return out;
    } catch (e) {
      await this.end(h, "failed");
      throw e;
    }
  }

  async skipped(stage: string): Promise<void> {
    await this.end(this.start(stage), "skipped");
  }
}

/** Milliseconds a recorded stage took. Null while it is still running. */
export function durationMs(row: StageRow): number | null {
  if (!row.endedAt) return null;
  return row.endedAt.getTime() - row.startedAt.getTime();
}
