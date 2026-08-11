import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSameFailure } from "../deploy-errors";
import type { Runtime } from "../fleet";
import { startBridge, redeployScript, type Redeploy } from "./bridge";
import { CodexBackend } from "./codex";
import { runAgent } from "./harness";
import { PLAN_SCHEMA, fromStructured } from "./plan-schema";
import { recordAgentRun } from "../agent-usage";
import type { AgentBackend } from "./types";
import {
  AGENT_MD,
  PLAN_AGENT_MD,
  PartialPlan,
  extractPlan,
  opencodeRepair,
  planDeploy as opencodePlanDeploy,
  type DeployPlan,
  type PlatformFacts,
  type RepairResult,
} from "../opencode-deploy";

/**
 * Which agent drives, and the one place that decides.
 *
 * Codex is the default. opencode stays wired and one variable away, because the
 * model and harness landscape moves faster than we can re-plan around it and the
 * cost of keeping the door open is one interface.
 *
 *   DEPLOY_AGENT=codex      (default)
 *   DEPLOY_AGENT=opencode
 */
export type AgentName = "codex" | "opencode";

export function agentName(): AgentName {
  return process.env.DEPLOY_AGENT === "opencode" ? "opencode" : "codex";
}

function backendFor(name: AgentName): AgentBackend {
  if (name === "codex") return new CodexBackend();
  throw new Error(`no AgentBackend for ${name}`);
}

const MODEL = process.env.DEPLOY_AGENT_MODEL || process.env.OPENCODE_MODEL || "gpt-5.6-sol";

/**
 * The model id, without any provider prefix.
 *
 * `OPENCODE_MODEL` is `<provider>/<model-id>` because opencode needs to be told
 * which SDK to use. Codex takes the bare id and rejects a slash, so the same
 * variable cannot be passed to both untouched — and it will be set to
 * `openai/gpt-5.6-sol` on every existing deployment.
 */
export function bareModel(m: string): string {
  const i = m.indexOf("/");
  return i >= 0 ? m.slice(i + 1) : m;
}

/**
 * Strip the write-a-file instructions from a prompt written for a backend that
 * had no other way to return a shape.
 *
 * `PLAN_AGENT_MD` tells the agent to `cat > …/plan.json <<'JSON'` and calls that
 * file "the deliverable", because opencode cannot constrain a final answer. Left
 * in, a schema-capable backend does the work twice: observed on a real run, the
 * agent wrote `plan.json`, then ran `cat plan.json`, then answered — two tool
 * calls spent on a file nothing reads, against a loop detector that counts.
 *
 * Deleting that workaround is the reason `--output-schema` is worth having, so
 * it is deleted rather than tolerated.
 */
export function forSchemaBackend(instructions: string): string {
  return instructions
    .split("\n")
    .filter((l) => !/plan\.json|WRITE the plan|That file is the deliverable|Deliver the plan by WRITING/i.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() +
    "\n\nAnswer with the plan as your FINAL MESSAGE, matching the required schema. " +
    "Write no files; the answer itself is the deliverable.\n";
}

export async function planDeploy(opts: {
  dir: string;
  log: (l: string) => void;
  timeoutMs?: number;
  /**
   * Who this plan is for, so its cost can be charged to a deploy.
   *
   * Optional because the planner is also run from tests and by hand, where
   * there is no deploy to charge. A missing slug means the run is not recorded,
   * not that it is recorded against nobody.
   */
  slug?: string;
  runId?: string | null;
}): Promise<DeployPlan> {
  if (agentName() === "opencode") return opencodePlanDeploy(opts);

  const { dir, log } = opts;
  const timeoutMs = opts.timeoutMs ?? Number(process.env.PLANNER_TIMEOUT_MS || 240000);
  const ws = mkdtempSync(join(tmpdir(), "ss-plan-"));

  let structured: unknown = null;
  let text = "";
  try {
    symlinkSync(dir, join(ws, "repo"));

    const backend = backendFor("codex");
    const spec = {
      ws,
      model: bareModel(MODEL),
      instructions: forSchemaBackend(PLAN_AGENT_MD),
      schema: PLAN_SCHEMA,
      // The planner reads a repo and answers. It installs nothing and calls
      // nothing, so it gets no network — the smallest permission that works.
      network: false,
      prompt:
        "Read the app in ./repo and produce its deploy plan. Investigate the files first, " +
        "then answer with the plan as your final message. Do not narrate.",
    };

    const startedAt = Date.now();
    const run = await runAgent({ backend, spec, log, label: "planner", timeoutMs });
    text = run.text;
    structured = backend.structured(spec);

    // Recorded here rather than at the return, because the tokens are spent by
    // now and several paths below throw — a partial plan, no usable JSON. A run
    // that cost money and then failed is exactly the one worth having on file.
    if (opts.slug) {
      await recordAgentRun({
        runId: opts.runId, slug: opts.slug, role: "planner",
        engine: "codex", model: bareModel(MODEL),
        tokens: run.tokens, steps: run.steps, durationMs: Date.now() - startedAt,
        outcome: run.ended === "timeout" ? "timeout" : run.error ? "error" : "ok",
      });
    }

    // A run that produced an answer is not a failure even if it was killed for
    // looping afterwards — the answer is read either way.
    if (!structured && run.error) log(`planner · ${run.error.slice(0, 160)}`);
  } finally {
    try { rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // The structured answer first. The prose fallback is kept because a killed or
  // failed turn can still leave a usable plan in the text, which is exactly what
  // the opencode path has always relied on.
  const shaped = fromStructured(structured);
  const plan = (shaped as DeployPlan | null) ?? extractPlan(text);
  if (!plan) throw new Error("planner produced no usable JSON plan");

  // Same rule as the opencode path, and the same reason: `other` (Go, Rust,
  // Java) is a legal plan with no run command, because those are built as
  // containers and carry their own entrypoint. Demanding one here threw away
  // every correct plan for those languages.
  if (!plan.static && !plan.run && plan.language !== "other") {
    throw new PartialPlan({ language: plan.language }, "planner returned no run command for a server app");
  }

  const outcome = plan.static ? (plan.outputDir || "the repository root") : (plan.run || "built as a container");
  log(`planner · ${plan.language}${plan.static ? " (static)" : ""}${plan.needsDB ? " +db" : ""} → ${outcome}`);
  return plan;
}

/**
 * Repair a failed deploy: same contract as `opencodeRepair`, same ground truth.
 *
 * The agent is not trusted. `ok` is whether the BRIDGE saw a successful deploy,
 * never whether the agent said so — an agent that claims it fixed something and
 * an agent that fixed something are different agents, and only one is detectable
 * from here.
 */
export async function agentRepair(opts: {
  dir: string;
  slug: string;
  initialError: string;
  plan?: DeployPlan | null;
  facts?: PlatformFacts | null;
  redeploy: Redeploy;
  /**
   * Which runtime `redeploy` actually reaches.
   *
   * Named and passed rather than inferred, for the reason the pipeline's call
   * site gives: the closure and the prompt must not be able to describe
   * different runtimes. It travels no further than `platform.json` here —
   * `AGENT_MD` already carries the rule that reads it, so both backends get the
   * same instruction from the same string.
   */
  runtime: Runtime;
  log: (l: string) => void;
  timeoutMs?: number;
  /** The deploy this repair belongs to, so its cost lands on that deploy. */
  runId?: string | null;
}): Promise<RepairResult> {
  if (agentName() === "opencode") {
    // Wrapped rather than recorded inside opencode-deploy.ts: the result already
    // carries the tokens, so the switch is the one place that can charge either
    // backend without either of them knowing this table exists.
    const startedAt = Date.now();
    const r = await opencodeRepair(opts);
    await recordAgentRun({
      runId: opts.runId, slug: opts.slug, role: "repair",
      engine: "opencode", model: bareModel(MODEL),
      tokens: r.tokens, steps: r.steps, redeploys: r.redeploys,
      durationMs: Date.now() - startedAt, outcome: r.ok ? "fixed" : "gave-up",
    });
    return r;
  }

  const { dir, slug, initialError, plan, facts, redeploy, runtime, log } = opts;
  const repairStartedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? Number(process.env.REPAIR_TIMEOUT_MS || 900000);
  const ws = mkdtempSync(join(tmpdir(), "ss-repair-"));

  const bridge = await startBridge({
    redeploy,
    log,
    maxRedeploys: Number(process.env.OPENCODE_MAX_REDEPLOYS || 3),
    // Loopback while the agent is a subprocess of this process. On a fleet node
    // this becomes the node's bridge gateway — see bridge.ts.
    bind: process.env.AGENT_BRIDGE_BIND || "127.0.0.1",
    sameFailure: isSameFailure,
  });

  let run: Awaited<ReturnType<typeof runAgent>> | null = null;
  try {
    symlinkSync(dir, join(ws, "repo"));

    // What the platform DECIDED and what it DID. Without these the agent sees an
    // error and a repo and nothing else, cannot tell which half of the failure
    // was ours, and edits the customer's code to compensate — it has written a
    // fake .env, sed-ed a migrate script out of package.json, and once burned
    // 287k tokens writing an application around what was actually an IAM grant.
    if (plan) writeFileSync(join(ws, "deploy-plan.json"), JSON.stringify(plan, null, 2));
    // `runsOn`, not `runtime`: `PlatformFacts` already spends that name on the
    // language runtime a repo pinned, and AGENT_MD's rule is written against
    // `runsOn`. The same spelling the opencode path writes, because the two
    // backends read the identical instruction string.
    if (facts) writeFileSync(join(ws, "platform.json"), JSON.stringify({ ...facts, runsOn: runtime }, null, 2));
    writeFileSync(join(ws, "redeploy.sh"), redeployScript(bridge.url));

    const backend = backendFor("codex");
    const spec = {
      ws,
      model: bareModel(MODEL),
      instructions: AGENT_MD,
      // The repair agent must reach the bridge and run gcloud. Every sandbox
      // mode blocks network by default, and getting this wrong looks like an
      // agent that edits files correctly and can never redeploy.
      network: true,
      prompt:
        `The deploy failed with this error:\n\n${initialError}\n\n` +
        "Fix the app in ./repo and run `bash redeploy.sh` until it deploys live.",
    };

    run = await runAgent({
      backend, spec, log, label: "agent", timeoutMs,
      // A repair legitimately takes many more steps than a plan: it edits, it
      // redeploys, it reads a new error, it edits again. The planner's budget
      // would kill it in the middle of working.
      maxCalls: Number(process.env.REPAIR_MAX_CALLS || 120),
      repeatsAllowed: 4,
    });
  } finally {
    bridge.close();
    if (process.env.OPENCODE_KEEP_WS === "1") log(`kept ws: ${ws}`);
    else try { rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const url = bridge.lastUrl();
  const ok = !!url;
  const changes = run?.changes ?? [];
  const tokens = run?.tokens ?? { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  log(
    `tokens · total ${tokens.total} (in ${tokens.input} / out ${tokens.output} / reasoning ${tokens.reasoning}` +
    ` / cacheRead ${tokens.cacheRead}) · ${run?.steps ?? 0} steps · ${bridge.redeploys()} redeploys`
  );

  await recordAgentRun({
    runId: opts.runId, slug, role: "repair",
    engine: "codex", model: bareModel(MODEL),
    tokens, steps: run?.steps ?? 0, redeploys: bridge.redeploys(),
    durationMs: Date.now() - repairStartedAt,
    outcome: ok ? "fixed" : run?.ended === "timeout" ? "timeout" : "gave-up",
  });

  return {
    ok, url, changes, steps: run?.steps ?? 0, redeploys: bridge.redeploys(), tokens,
    summary: ok
      ? `Fixed via ${agentName()}: ${changes.join(", ") || "config"}`
      : `${agentName()} couldn't get it live after ${bridge.redeploys()} redeploys`,
  };
}

export { PartialPlan, type DeployPlan };
export type { PlatformFacts } from "../opencode-deploy";
