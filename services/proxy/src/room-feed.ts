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

/**
 * What a step looks like on screen. Not a stage name — a thing that happens in
 * the room.
 *
 * The list is drawn from what this pipeline actually says, counted over the
 * 8,140 events in `deploy_events`, not from what a build is imagined to say. The
 * first version of this module guessed at `npm install` and `docker pull` output
 * and was nearly useless against the real thing, which narrates in prose written
 * for people: "Unpacking your project…", "Detecting stack…", "Plan ready".
 */
export type StepKind =
  | "unpack"    // the source arrives — "Unpacking your project…" (89)
  | "detect"    // working out what this is — "Detecting stack…" (90), "Detected Node · JavaScript" (51)
  | "prepare"   // dependencies — "preparing…" (185)
  | "build"     // "building…" (589), "building api…", "Building with layer cache"
  | "pull"      // the base image — "Base pinned to …node:24 @ sha256…" (39)
  | "provision" // a database or bucket appears — "Provisioning Postgres…" (45)
  | "release"   // "release runs on the node, before the app starts" (44)
  | "boot"      // "deploying…" (144), "Creating Revision…", "verifying the app responds…"
  | "repair"    // the repair agent takes over — `agent …` is the SECOND most common opener (368)
  | "work"      // something happened that none of the above describes
  | "broke";

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
/**
 * Which kind of movement a build line is.
 *
 * ORDER IS THE WHOLE THING. These tests are not disjoint — "Building an image on
 * node 24" contains both `building` and `image`, and the first version checked
 * `image` first, so the single most important line in a deploy was drawn as a
 * download. The most specific claim wins, and the frequencies above decide what
 * "specific" means here.
 *
 * Interpretation is allowed; invention is not. Every branch below maps one real
 * line to one movement, and the count of movements still equals the count of
 * real lines. When the pipeline's wording changes, re-count and rewrite this —
 * that is cheaper than it looks and it is the only thing keeping the room honest.
 */
export function classify(line: string): StepKind {
  const l = line.toLowerCase();
  // The repair agent, before anything else: its lines describe another actor
  // entirely, and several of them also contain "build".
  if (/^agent\b|repair agent|\bagent (took|takes|is|has)\b/.test(l)) return "repair";
  if (/\bunpack/.test(l)) return "unpack";
  if (/\bdetect/.test(l)) return "detect";
  if (/\bprovision|\bdatabase\b|\bpostgres\b|\bbucket\b/.test(l)) return "provision";
  // Before `build`: "Building with layer cache" is a build, but "Base pinned to
  // …@ sha256" is the base image arriving.
  if (/\bbase pinned\b|\bpulling\b|\bdownloading\b/.test(l)) return "pull";
  if (/\bprepar/.test(l)) return "prepare";
  if (/\bbuild|\bcompil|\bbundl|\bvite\b|\btsc\b/.test(l)) return "build";
  if (/\brelease\b/.test(l)) return "release";
  if (/\bdeploy|\brevision\b|\bverifying\b|\blive\b|\blisten|\bserving\b|\bready\b/.test(l)) return "boot";
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

/**
 * The end of a run, for someone who has just walked in.
 *
 * A room opened at minute nine of a build starts empty otherwise, which reads as
 * "nothing is happening" when a great deal has. This is the backlog, and it is
 * the tail rather than the head for the same reason a log is: the interesting
 * part of a build in progress is where it has got to.
 */
export async function tailSteps(runId: string, limit = 30): Promise<StepPage> {
  try {
    const r = await db().query(
      `SELECT id, event FROM (
         SELECT id, event FROM deploy_events WHERE run_id = $1 ORDER BY id DESC LIMIT $2
       ) t ORDER BY id`,
      [runId, limit],
    );
    let cursor = 0;
    const steps: RoomStep[] = [];
    for (const row of r.rows as Array<{ id: string | number; event: Record<string, unknown> }>) {
      cursor = Number(row.id);
      const step = stepOf(cursor, row.event ?? {});
      if (step) steps.push(step);
    }
    return { steps, cursor };
  } catch {
    return { steps: [], cursor: 0 };
  }
}

/** Strip what a guest must not read. */
export function forGuest(steps: RoomStep[]): RoomStep[] {
  return steps.map(({ id, kind }) => ({ id, kind }));
}
