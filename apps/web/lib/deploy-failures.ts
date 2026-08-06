import { getPool } from "./db";

const DB = "supersonic_platform";

/**
 * What is stored when a failure arrived with no reason attached.
 *
 * One exact string, because the success criterion for this work counts rows
 * carrying it — it is the size of the remaining reporting gap. Two spellings
 * would count as one gap and one real cause, which is the measurement failing
 * quietly rather than loudly.
 */
export const NO_REASON = "no reason captured — this is a reporting gap, not a cause";

/**
 * The error, or the fact that there wasn't one.
 *
 * `result.error ?? "deploy failed"` in the pipeline guards null and lets `""`
 * straight through, because `??` does not test for blank — which is how six of
 * twenty-three recorded failures came to say nothing. Whitespace is blank too: a
 * cause of "\n" is no more of an answer than an empty one.
 */
export function causeOf(error: string | null | undefined): string {
  const e = (error ?? "").trim();
  return e === "" ? NO_REASON : error!;
}

/**
 * A failure headline joined to its reason, or an honest sentence when there is none.
 *
 * `Build failed:\n${reason}` renders as exactly `Build failed:` when the reason is
 * empty, and three rows on file are that. A header with nothing after the colon
 * reads like a message somebody truncated, so it sends its reader hunting for a
 * cause that was never captured — while a sentence saying the reason is missing
 * points at the reporting gap, which is where the bug actually is.
 */
export function failureSentence(headline: string, reason: string | null | undefined): string {
  const r = (reason ?? "").trim();
  return r === "" ? `${headline} — ${NO_REASON}` : `${headline}:\n${reason}`;
}

export type Repair = "skipped" | "fixed" | "gave-up";

export interface FailureRow {
  runId: string | null;
  slug: string;
  ownerId: string | null;
  stage: string | null;
  cause: string;
  blame: "platform" | "app";
}

/** Where a failure is written. Swapped out in tests. */
export interface FailureSink {
  insert(row: FailureRow): Promise<string>;
  setRepair(id: string, repair: Repair, summary: string | null): Promise<void>;
}

export const postgresSink: FailureSink = {
  async insert(row) {
    const { rows } = await getPool(DB).query<{ id: string }>(
      `INSERT INTO deploy_failures (run_id, slug, owner_id, stage, cause, blame)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [row.runId, row.slug, row.ownerId, row.stage, row.cause, row.blame],
    );
    return rows[0].id;
  },
  async setRepair(id, repair, summary) {
    await getPool(DB).query(
      `UPDATE deploy_failures SET repair = $2, repair_summary = $3 WHERE id = $1`,
      [id, repair, summary],
    );
  },
};

/**
 * Records why one deploy failed, and how the repair of it ended.
 *
 * One recorder per deploy: it holds the id of the row it inserted so the repair
 * outcome lands on that row rather than on a second one. A failed-then-repaired
 * attempt is one attempt.
 *
 * Every write is wrapped, for the same reason `StageRecorder`'s are: a broken
 * sink must cost us the observation and nothing else. That is the most important
 * property of this class.
 */
export class FailureRecorder {
  private id: string | null = null;

  constructor(
    private readonly sink: FailureSink = postgresSink,
    private readonly onError: (e: unknown) => void = (e) => console.error("failure record failed", e),
  ) {}

  /** The cause, at the moment blame is decided and before it branches the flow. */
  async record(row: FailureRow): Promise<void> {
    try {
      this.id = await this.sink.insert(row);
    } catch (e) {
      this.onError(e);
    }
  }

  /**
   * How the repair ended.
   *
   * Silently does nothing when no row was inserted: without a cause beside it, a
   * repair verdict alone is the shape this table exists to stop.
   */
  async repaired(repair: Repair, summary: string | null): Promise<void> {
    if (!this.id) return;
    try {
      await this.sink.setRepair(this.id, repair, summary);
    } catch (e) {
      this.onError(e);
    }
  }
}
