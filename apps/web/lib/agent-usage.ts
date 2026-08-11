import { getPool } from "./db";

/**
 * What an agent run cost, per run.
 *
 * RECONSTRUCTED. `lib/agents/index.ts` imports this module at three call sites
 * and it was never committed — the build on `main` has been failing since, which
 * is why production is serving an older revision. This is rebuilt from those
 * three call sites and from the shape they pass; whoever wrote the original
 * should replace it and will get a conflict here rather than silence.
 *
 * The repair agent is the single most expensive thing the platform can do on a
 * user's behalf — an LLM session that reads a repo, edits it and redeploys, up
 * to MAX_REDEPLOYS times — and until this table nothing recorded what one cost.
 * `usage` counts that a run happened; this records what it spent.
 *
 * Best-effort throughout, like every other telemetry write here: losing the
 * record of a repair must never be the reason a repair fails. A deploy that
 * worked and a row that did not is a worse outcome only for us.
 */

const DB = "supersonic_platform";

/**
 * Created lazily rather than by a migration, and that is a compromise worth
 * naming. The recent practice in this schema is a numbered file in `db/`, and
 * this should become one. It is not one today because `main` is broken right
 * now, two sessions are pushing, and 025 was claimed twice within the hour —
 * so taking another number in a race is how the schema loses its order a third
 * time. `deploy_runs`, `deploy_events` and `cli_tokens` all ensure themselves
 * this way; this joins them until someone gives it a number.
 */
let ensured: Promise<void> | null = null;
function ensure(): Promise<void> {
  if (!ensured) {
    ensured = getPool(DB)
      .query(
        `CREATE TABLE IF NOT EXISTS agent_runs (
           id          bigserial PRIMARY KEY,
           run_id      text,
           slug        text NOT NULL,
           role        text NOT NULL,
           engine      text NOT NULL,
           model       text,
           tokens      jsonb,
           steps       int,
           redeploys   int,
           duration_ms bigint,
           outcome     text NOT NULL,
           at          timestamptz NOT NULL DEFAULT now()
         )`,
      )
      .then(() =>
        getPool(DB).query(
          `CREATE INDEX IF NOT EXISTS agent_runs_slug_at ON agent_runs (slug, at DESC)`,
        ),
      )
      .then(() => undefined)
      .catch((e) => {
        ensured = null;
        throw e;
      });
  }
  return ensured;
}

export interface AgentRun {
  /** Which deploy this belonged to. Null or absent on the in-request path, as elsewhere. */
  runId?: string | null;
  slug: string;
  /** `planner` reads a repo to decide how to deploy it; `repair` edits one. */
  role: "planner" | "repair";
  engine: string;
  model?: string;
  /** Whatever the backend counted — `Tokens` from codex, `TokenUsage` from
   *  opencode. Typed as an object rather than a common shape on purpose: the two
   *  count different things, and a shared interface would have to drop whichever
   *  fields the other one has. It is stored as jsonb and never read back in
   *  code, so the structure is the backend's to define. */
  tokens?: object | null;
  steps?: number;
  redeploys?: number;
  durationMs?: number;
  /**
   * How it ended, in the vocabulary the call sites already use: a planner ends
   * `ok`, `error` or `timeout`; a repair ends `fixed`, `gave-up` or `timeout`.
   * Not normalised into one set — "the planner produced no plan" and "the repair
   * agent gave up" are different facts and collapsing them would lose which.
   */
  outcome: string;
}

export async function recordAgentRun(run: AgentRun): Promise<void> {
  try {
    await ensure();
    await getPool(DB).query(
      `INSERT INTO agent_runs
         (run_id, slug, role, engine, model, tokens, steps, redeploys, duration_ms, outcome)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`,
      [
        run.runId ?? null,
        run.slug,
        run.role,
        run.engine,
        run.model ?? null,
        run.tokens ? JSON.stringify(run.tokens) : null,
        run.steps ?? null,
        run.redeploys ?? null,
        run.durationMs ?? null,
        run.outcome,
      ],
    );
  } catch (e) {
    console.error("agent-usage: could not record a run", e instanceof Error ? e.message : String(e));
  }
}
