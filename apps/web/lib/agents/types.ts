/**
 * The seam between the platform and whichever coding agent CLI is driving.
 *
 * A backend's only job is to run a CLI and normalise its event stream. Nothing
 * else. Everything that exists because we learned it the hard way — the redeploy
 * bridge whose `lastUrl` is the only trusted signal, the loop detector, the
 * `platform.json` that stops an agent editing a customer's code around an IAM
 * grant — lives ABOVE this interface, written once.
 *
 * If any of that ends up implemented per-backend, the switch has cost more than
 * it bought. That is the defect `DEPLOY-PLAN.md` is named after: one rule, two
 * readers, and only one of them gets fixed.
 */

/** Token counts, as RUNNING TOTALS for the run so far. */
export interface Tokens {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export const ZERO_TOKENS: Tokens = {
  total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0,
};

/**
 * One normalised thing that happened, whichever CLI produced it.
 *
 * `usage` is a SNAPSHOT OF TOTALS, never an increment. The two backends disagree
 * natively — opencode emits per-step deltas on `step_finish`, Codex emits a
 * cumulative total on `turn.completed` — and a shared layer that had to know
 * which it was holding would be the first crack in the seam. Each backend
 * converts to totals; the harness keeps the last one it saw.
 */
export interface AgentEvent {
  kind: "tool" | "text" | "usage" | "error";
  /** A tool call, for the live log and the loop detector. */
  tool?: {
    /** `bash`, `edit`, `read` — normalised, not the backend's spelling. */
    name: string;
    /** The command, path or pattern; whatever identifies THIS call. */
    detail: string;
    /** Workspace-relative paths this call wrote, if any. Feeds `changes`. */
    editedPaths?: string[];
  };
  /** Assistant prose. */
  text?: string;
  usage?: Tokens;
  error?: string;
}

/** Everything a backend needs to run once. */
export interface RunSpec {
  /** The agent's cwd. The repo is at `<ws>/repo`. */
  ws: string;
  prompt: string;
  model: string;
  /** The system prompt — AGENT_MD or PLAN_AGENT_MD. */
  instructions: string;
  /**
   * JSON Schema the final answer must match, when the backend can enforce it.
   *
   * Optional because opencode cannot: it gets the write-a-file-then-parse path
   * instead. The switch must not drag Codex's win backwards into opencode, nor
   * force opencode's workaround onto Codex.
   */
  schema?: unknown;
  /**
   * Whether this run needs outbound network.
   *
   * The planner does not; the repair agent must reach the redeploy bridge and
   * run `gcloud`. Every sandbox mode blocks network by default, so getting this
   * wrong looks like an agent that edits files correctly and can never redeploy.
   */
  network: boolean;
  /** Extra variables for the child, merged over the backend's own. */
  env?: NodeJS.ProcessEnv;
}

export interface AgentBackend {
  readonly name: string;

  /** Write whatever the CLI expects to find in the workspace before it starts. */
  seed(spec: RunSpec): Promise<void>;

  /** The binary to spawn. */
  bin(): string;

  argv(spec: RunSpec): string[];

  /** A clean, explicit environment — never the parent's, see `harness.ts`. */
  env(spec: RunSpec): NodeJS.ProcessEnv;

  /** One line of stdout → one normalised event, or null for noise. */
  parse(line: string): AgentEvent | null;

  /**
   * The schema-shaped final answer, if this backend produced one.
   *
   * Null means "I have no structured result" — the caller falls back to
   * extracting a plan from the accumulated text, which is what opencode has
   * always done.
   */
  structured(spec: RunSpec): unknown | null;
}
