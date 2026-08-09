import { db } from "./db";

/**
 * Who caused a build: you, an agent, the platform — or `someone`, when nobody
 * said.
 *
 * This type is declared again in apps/web/lib/builds.ts. The proxy and the app
 * are separate services with separate packages, so the type is declared twice
 * rather than imported — there is no shared package between them. The `builds_who`
 * CHECK constraint in the database schema keeps the two declarations honest:
 * if one side's values drift from the other's, the database will reject the write
 * at source. This is what prevents the silent disagreement that retired the
 * `lane` term entirely from this codebase.
 */
export type Who = "you" | "agent" | "platform" | "someone";

export interface Tick {
  runId: string;
  who: Who;
  startedAt: number;
  endedAt: number | null;
  outcome: "ok" | "failed" | null;
  /** True when this build's lines have been pruned, so the reader can say so. */
  linesGone: boolean;
}

/**
 * Whether `deploy_events` still holds this build's lines.
 *
 * Mirrors `pruneEvents(days = 7)` in apps/web/lib/deploy-events.ts, which is
 * called at the start of every deploy. If that default changes, change this one
 * with it — they are the same number seen from two services.
 */
export function linesGone(startedAtMs: number, nowMs: number, retentionDays = 7): boolean {
  return nowMs - startedAtMs > retentionDays * 86_400_000;
}

/** This app's builds, newest first. */
export async function listBuilds(slug: string, limit = 50): Promise<Tick[]> {
  const now = Date.now();
  try {
    const r = await db().query(
      `SELECT run_id, who, started_at, ended_at, outcome
         FROM builds WHERE slug = $1 ORDER BY started_at DESC LIMIT $2`,
      [slug, limit],
    );
    return r.rows.map((row) => {
      const startedAt = new Date(row.started_at).getTime();
      return {
        runId: row.run_id, who: row.who as Who, startedAt,
        endedAt: row.ended_at ? new Date(row.ended_at).getTime() : null,
        outcome: row.outcome ?? null,
        linesGone: linesGone(startedAt, now),
      };
    });
  } catch {
    return [];
  }
}
