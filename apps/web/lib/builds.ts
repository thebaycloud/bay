import { getPool } from "./db";

/**
 * Who caused a build: you, an agent, the platform — or `someone`, when nobody
 * said.
 *
 * The tempting implementation reads a TTY and calls the answer `agent` when
 * there isn't one. CI has no TTY either, so that reports an agent where there
 * was none, in the one field the whole surface exists to show. An honest blank
 * costs less than a confident lie.
 */
export type Who = "you" | "agent" | "platform" | "someone";

const DECLARED: readonly string[] = ["you", "agent", "platform"];

export function normaliseWho(declared: string | null | undefined): Who {
  const v = (declared ?? "").trim().toLowerCase();
  return (DECLARED.includes(v) ? v : "someone") as Who;
}

const DB = "supersonic_platform";

export interface BuildRow {
  run_id: string; slug: string; who: Who;
  started_at: string; ended_at: string | null;
  outcome: "ok" | "failed" | null;
}

/** Split out from the write so the normalisation is testable without a database. */
export function buildStartSql(runId: string, slug: string, who: string | null | undefined) {
  return {
    text: `INSERT INTO builds(run_id, slug, who) VALUES($1,$2,$3)
             ON CONFLICT (run_id) DO NOTHING`,
    values: [runId, slug, normaliseWho(who)],
  };
}

export function buildFinishSql(runId: string, outcome: "ok" | "failed") {
  return {
    text: `UPDATE builds SET ended_at = now(), outcome = $2 WHERE run_id = $1`,
    values: [runId, outcome],
  };
}

/** Best-effort, both of them: losing the record of a build must not fail the build. */
export async function startBuild(runId: string, slug: string, who: string | null | undefined): Promise<void> {
  const q = buildStartSql(runId, slug, who);
  try { await getPool(DB).query(q.text, q.values); } catch { /* ignore */ }
}

export async function finishBuild(runId: string, outcome: "ok" | "failed"): Promise<void> {
  const q = buildFinishSql(runId, outcome);
  try { await getPool(DB).query(q.text, q.values); } catch { /* ignore */ }
}
