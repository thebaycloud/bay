/**
 * What the batch is doing RIGHT NOW, on disk, for anything that wants to watch.
 *
 * The results file answers "how did it go" and can only answer it afterwards:
 * a row is appended when a project is finished with. For the twenty minutes
 * before that, a batch running four projects at once emits nothing but
 * interleaved lines into a terminal, which is why watching one is unreadable —
 * four pipelines are progressing in parallel and the only rendering of them is a
 * flat list.
 *
 * So this is the other half: a single JSON file, rewritten whenever anything
 * changes, holding the current state of every project. It is deliberately a
 * FILE and not a socket or a port. The harness must not gain a server — a batch
 * is an hour of real builds and it cannot become fragile because something was
 * listening. A file has no connection to lose, survives the watcher being closed
 * and reopened, and is still there afterwards to explain what happened.
 *
 * Written atomically (write to a temp name, rename over) because a reader is
 * polling it a few times a second and `rename` is the only way to make sure it
 * never observes half a document.
 */
import { renameSync, writeFileSync } from "node:fs";

export type ProjectState =
  | "pending"      // in the queue, no lane free yet
  | "waiting"      // refused at the ceiling, retrying
  | "deploying"    // the CLI is running
  | "probing"      // the pipeline said live; asking the URL
  | "done";

export interface ProjectStatus {
  key: string;
  state: ProjectState;
  /** cold/warm and which repetition, so a batch with reps reads correctly. */
  mode: string | null;
  rep: number | null;
  slug: string | null;
  url: string | null;
  /** ms since this project's current attempt began — the number a watcher counts up. */
  startedAt: number | null;
  reservedMs: number | null;
  activatedMs: number | null;
  firstOkMs: number | null;
  /** The last thing the deploy said about itself, from the CLI's own stream. */
  line: string | null;
  /** The deploy's narration, newest last. Capped — a watcher wants the recent past. */
  lines: string[];
  /** Which of the pipeline's phases `line` belongs to. See `phaseOf`. */
  phase: string | null;
  /**
   * When the deploy last said anything.
   *
   * Kept because silence is a measurement here, not an absence of one. A deploy
   * on the production path goes quiet for around two minutes after the upload —
   * the control plane hands the work to a Cloud Run Job, and until that job
   * starts there is nothing for the client to be told. That gap is the handoff
   * cost `app/api/deploy/route.ts` describes as unmeasured, so it is the single
   * most interesting thing on the screen; and rendered without a timer it is
   * indistinguishable from a page that has frozen.
   */
  lastLineAt: number | null;
  outcome: string | null;
  verdict: string | null;
  cause: string | null;
  /** How many times the ceiling has turned this project away. */
  waits: number;
}

export interface BatchStatus {
  batch: string;
  target: string;
  url: string;
  concurrency: number;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  projects: ProjectStatus[];
}

/**
 * The phase a log line belongs to.
 *
 * Derived from the deploy's own words rather than from `deploy_stages`, which is
 * the authority and is unreachable: it lives in Postgres behind cloud-sql-proxy,
 * and the point of this file is to be readable by someone who has not set that
 * up. So this is a reading of prose, and it is wrong the moment somebody
 * rewrites a log line.
 *
 * Which is survivable ONLY because the raw line is always carried beside the
 * phase and always rendered. A watcher that showed the guess alone would quietly
 * mislabel deploys forever; one that shows the sentence underneath it lets
 * anyone see the mislabelling immediately. The phase is a convenience for
 * arranging colour and order, never a claim.
 */
export function phaseOf(line: string): string | null {
  const l = line.toLowerCase();
  if (/will be live at|reserv/.test(l)) return "reserve";
  if (/pulling|cloning|unpacking|uploading/.test(l)) return "source";
  if (/detect/.test(l)) return "detect";
  if (/plan|planner/.test(l)) return "plan";
  if (/build|image|buildkit|cloud build/.test(l)) return "build";
  if (/deploy|release|fleet|revision/.test(l)) return "deploy";
  if (/repair|agent|codex|redeploy/.test(l)) return "repair";
  if (/live at|✓ live/.test(l)) return "live";
  return null;
}

/** The phases a watcher lays out, in the order a deploy passes through them. */
export const PHASES = ["reserve", "source", "detect", "plan", "build", "deploy", "repair", "live"] as const;

export class Status {
  private readonly file: string;
  private readonly state: BatchStatus;

  constructor(file: string, head: Omit<BatchStatus, "projects" | "updatedAt" | "finishedAt">, keys: string[]) {
    this.file = file;
    this.state = {
      ...head,
      updatedAt: Date.now(),
      finishedAt: null,
      projects: keys.map((key) => ({
        key, state: "pending", mode: null, rep: null, slug: null, url: null,
        startedAt: null, reservedMs: null, activatedMs: null, firstOkMs: null,
        line: null, lines: [], phase: null, lastLineAt: null,
        outcome: null, verdict: null, cause: null, waits: 0,
      })),
    };
    this.flush();
  }

  /** Change one project and publish. Unknown keys are ignored rather than thrown: a
   *  status file must never be the reason a batch of real builds dies. */
  update(key: string, patch: Partial<ProjectStatus>): void {
    const p = this.state.projects.find((x) => x.key === key);
    if (!p) return;
    Object.assign(p, patch);
    this.flush();
  }

  /** Record a line of the deploy's narration against a project. */
  say(key: string, line: string): void {
    const p = this.state.projects.find((x) => x.key === key);
    if (!p) return;
    const clean = line.replace(/\[[0-9;]*m/g, "").trimEnd();
    if (!clean.trim()) return;
    p.line = clean;
    p.lastLineAt = Date.now();
    p.lines.push(clean);
    // The recent past only. A repair agent can emit hundreds of lines and the
    // whole file is rewritten on every one of them.
    if (p.lines.length > 40) p.lines = p.lines.slice(-40);
    p.phase = phaseOf(clean) ?? p.phase;
    this.flush();
  }

  finish(): void {
    this.state.finishedAt = Date.now();
    this.flush();
  }

  private flush(): void {
    this.state.updatedAt = Date.now();
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.file);
    } catch {
      // Best effort, always. Watching a batch is not worth failing one over.
    }
  }
}
