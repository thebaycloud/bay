import type { DetectedStack } from "./infer-services";

/**
 * Asking the deploy agent what a directory is, and saying what came back.
 *
 * Two jobs that were one block of eleven lines, and they are not the same job:
 * FINDING OUT is I/O against a subprocess, and TELLING THE USER is a pure
 * function of the answer. Split because only the second is worth testing
 * exhaustively and only the first needs anything spawned.
 *
 * The invocation existed twice in deploy-pipeline.ts — inline inside `runDeploy`,
 * which wants the provisioning plan too, and again in `detectStackIn`, which
 * wants only the stack. Both carried the same `slice(indexOf("{"))`, which is not
 * a flourish: see `parse`.
 */

/** Where the deploy agent lives, as an npm prefix. */
export const AGENT_PREFIX = "apps/agent";

/** Runs a command and resolves with its stdout. Injected so tests spawn nothing. */
export type Capture = (cmd: string, args: string[]) => Promise<string>;

/**
 * What the agent actually answers, which is WIDER than `DetectedStack` declares.
 *
 * `DetectedStack` is the shape the platform's own inference produces and the one
 * `serviceFor` consumes. The subprocess answers that plus four fields nothing
 * typed: `confidence` and `cache` and `secretsNeeded` are reported to the user,
 * and `runtime` is read at six places in the pipeline to pick a base image.
 *
 * They were invisible because the parse was `JSON.parse(...)` into `any`, so
 * every one of those reads type-checked against nothing. Declared here, where
 * the subprocess's contract belongs, rather than widened into `DetectedStack` —
 * that interface has implementations other than this agent, and they answer none
 * of these.
 */
export interface AgentStack extends DetectedStack {
  /** 0–1. Absent from some answers; `describeDetection` reads a missing one as 0. */
  confidence?: number;
  /** A cache the repo implies, e.g. "redis". */
  cache?: string | null;
  /** Names the deploy should ask the user for before building. */
  secretsNeeded?: string[];
  /** The language version to build on, e.g. "python3.12". */
  runtime?: string;
}

/** Everything the detector answers. */
export interface Detection {
  stack: AgentStack;
  /** The provisioning the detector believes this repo implies. Shape owned by the agent. */
  provisionPlan?: unknown;
}

/**
 * What this directory looks like to the detector.
 *
 * Rejects when the subprocess fails or answers something that is not JSON. A
 * caller that wants the detector's opinion to be optional catches; the deploy
 * does not, because every routing decision after this reads the answer.
 */
export async function detectStack(dir: string, capture: Capture, agentPrefix = AGENT_PREFIX): Promise<Detection> {
  const raw = await capture("npm", ["--prefix", agentPrefix, "run", "detect", "--silent", "--", dir, "--api"]);
  return parse(raw);
}

/**
 * The JSON inside whatever npm printed.
 *
 * `npm run --silent` is quieter than `npm run`, not silent: a warning, a funding
 * notice or a lifecycle line can precede the output, and any of them makes
 * `JSON.parse` of the whole string throw on character 1. Slicing from the first
 * brace is what makes this survive an npm that decided to say something.
 *
 * Its own function so the rule is stated once and can be tested without a
 * subprocess — which is the only way to test it, since reproducing npm's noise
 * on demand is not something a test can arrange.
 */
export function parse(stdout: string): Detection {
  const brace = stdout.indexOf("{");
  if (brace < 0) throw new Error(`the detector printed no JSON: ${stdout.trim().slice(0, 200)}`);
  return JSON.parse(stdout.slice(brace)) as Detection;
}

/**
 * What to tell the user about what was found, as lines to log.
 *
 * Returned rather than logged, so this is a pure function of the detection and a
 * test can assert every branch without capturing output. The branches are the
 * point: a database, a cache and a secret list each appear only when there is
 * one, and each of them commits the platform to provisioning something — so a
 * line that fails to appear is a surprise later, and one that appears wrongly is
 * a promise the deploy does not keep.
 */
export function describeDetection(d: Detection): string[] {
  const s = d.stack;
  const lines = [`Detected ${s.framework} · ${s.language} (${Math.round((s.confidence ?? 0) * 100)}%)`];
  if (s.database?.engine) lines.push(`Provision ${s.database.engine} (via ${s.database.via})`);
  if (s.cache) lines.push(`Provision ${s.cache} cache`);
  if (s.secretsNeeded?.length) lines.push(`Will ask for secrets: ${s.secretsNeeded.join(", ")}`);
  return lines;
}
