import { getPool } from "./db";

const DB = "supersonic_platform";

export type Lane = "static" | "fast" | "generic" | "runner";
export type Outcome = "ok" | "failed" | "skipped";

export interface StageRow {
  slug: string;
  lane: Lane;
  stage: string;
  startedAt: Date;
  endedAt: Date | null;
  outcome: Outcome | null;
}

/** Where a stage's timings are written. Swapped out in tests. */
export interface StageSink {
  write(row: StageRow): Promise<void>;
}

export const postgresSink: StageSink = {
  async write(row) {
    await getPool(DB).query(
      `INSERT INTO deploy_stages (slug, lane, stage, started_at, ended_at, outcome)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.slug, row.lane, row.stage, row.startedAt, row.endedAt, row.outcome],
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
    private readonly lane: Lane,
    private readonly sink: StageSink = postgresSink,
    private readonly now: () => Date = () => new Date(),
    private readonly onError: (e: unknown) => void = (e) => console.error("stage write failed", e),
  ) {}

  start(stage: string): StageHandle {
    return { stage, startedAt: this.now() };
  }

  async end(handle: StageHandle, outcome: Outcome): Promise<void> {
    try {
      await this.sink.write({
        slug: this.slug,
        lane: this.lane,
        stage: handle.stage,
        startedAt: handle.startedAt,
        endedAt: this.now(),
        outcome,
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
