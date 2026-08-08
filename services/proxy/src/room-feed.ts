import { db } from "./db";

/**
 * What the room is allowed to know.
 *
 * The room renders a build, and the rule it exists under is that every movement
 * on screen stands for something that actually happened. So this module converts
 * the deploy's own event log into movements and nothing else: one stored event in,
 * at most one step out. There is deliberately no way to ask it for "some activity"
 * — a room with nothing to show has to show nothing.
 *
 * The events are already durable (`deploy_events`, written by the pipeline through
 * apps/web/lib/deploy-events.ts) and already carry their own cursor, so the room is
 * a second reader of a log that exists rather than a new pipe out of the build.
 */

/** What a step looks like on screen. Not a stage name — a thing the agent does. */
export type StepKind = "pull" | "deps" | "build" | "boot" | "work" | "broke";

export interface RoomStep {
  /** The `deploy_events` id. Also the cursor to resume from. */
  id: number;
  kind: StepKind;
  /**
   * The real line behind the movement.
   *
   * Owners only. A shared link is the point of the room, and the first one to
   * leak would carry file paths, package names and stack frames out of somebody's
   * repo — so a guest gets the movement and not the words. Withheld here rather
   * than in the renderer, so a bug in the page cannot turn into a disclosure.
   */
  text?: string;
}

/**
 * Which kind of movement a build line is.
 *
 * Reading the line rather than the stage, because stages are the wrong grain:
 * seven of them span a 210-second deploy, and a room that changes picture twice
 * a minute is a slideshow. The lines arrive at the speed of the build, which is
 * the speed the room wants.
 *
 * This is interpretation, and interpretation is allowed — the count of movements
 * still equals the count of real lines. What is not allowed is inventing a line.
 */
export function classify(line: string): StepKind {
  const l = line.toLowerCase();
  if (/\b(pull|pulling|download|downloading|layer|image)\b/.test(l)) return "pull";
  if (/\b(npm|pnpm|yarn|pip|poetry|bundle|go mod|cargo|install|installing|added \d|packages)\b/.test(l)) return "deps";
  if (/\b(build|building|compil|bundl|webpack|vite|tsc|transpil)\b/.test(l)) return "build";
  if (/\b(start|starting|listen|listening|boot|booting|ready|serving|health)\b/.test(l)) return "boot";
  return "work";
}

/** One stored event as a step, or null when it is not something that happened on screen. */
export function stepOf(id: number, event: Record<string, unknown>): RoomStep | null {
  if (event.type === "log" && typeof event.line === "string") {
    const text = event.line.trim();
    if (!text) return null;
    return { id, kind: classify(text), text };
  }
  if (event.type === "error" && typeof event.message === "string") {
    return { id, kind: "broke", text: String(event.message) };
  }
  // `done`, `detected`, `patch` and the rest carry structure, not motion. The room
  // does not open on `done` — it opens when the app actually answers. See room.ts.
  return null;
}

/** The run the room is narrating: the app's most recent one. */
export async function latestRunId(slug: string): Promise<string | null> {
  try {
    const r = await db().query(
      `SELECT run_id FROM deploy_events WHERE slug = $1 ORDER BY id DESC LIMIT 1`,
      [slug],
    );
    return r.rows[0]?.run_id ?? null;
  } catch {
    return null;
  }
}

export interface StepPage {
  steps: RoomStep[];
  /**
   * Where to resume, which is NOT the last step's id.
   *
   * Most stored events produce no step — `detected`, `patch`, `done`. If the
   * cursor only ever advanced past events that rendered, a run whose tail is all
   * structure would be re-read on every poll, forever, and a build that ends in
   * silence would never let the reader move on.
   */
  cursor: number;
}

/**
 * Steps for one run after a cursor, oldest first.
 *
 * Bounded, because a room opened halfway through a long build would otherwise
 * replay every line at once and the agent would teleport through ten minutes of
 * work in a single frame. The caller pages; the cursor makes that free.
 */
export async function stepsAfter(runId: string, afterId: number, limit = 40): Promise<StepPage> {
  try {
    const r = await db().query(
      `SELECT id, event FROM deploy_events WHERE run_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
      [runId, afterId, limit],
    );
    let cursor = afterId;
    const steps: RoomStep[] = [];
    for (const row of r.rows as Array<{ id: string | number; event: Record<string, unknown> }>) {
      cursor = Number(row.id);
      const step = stepOf(cursor, row.event ?? {});
      if (step) steps.push(step);
    }
    return { steps, cursor };
  } catch {
    return { steps: [], cursor: afterId };
  }
}

/** Strip what a guest must not read. */
export function forGuest(steps: RoomStep[]): RoomStep[] {
  return steps.map(({ id, kind }) => ({ id, kind }));
}
