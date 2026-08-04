import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexBackend } from "./codex";
import { runAgent } from "./harness";
import { PLAN_SCHEMA, fromStructured } from "./plan-schema";
import type { AgentBackend } from "./types";
import {
  PLAN_AGENT_MD,
  PartialPlan,
  extractPlan,
  planDeploy as opencodePlanDeploy,
  type DeployPlan,
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

    const run = await runAgent({ backend, spec, log, label: "planner", timeoutMs });
    text = run.text;
    structured = backend.structured(spec);

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

export { PartialPlan, type DeployPlan };
export type { PlatformFacts } from "../opencode-deploy";
