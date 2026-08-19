import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { opencodeBin, opencodeConfig, providerToken } from "../opencode-deploy";
import type { AgentBackend, AgentEvent, RunSpec } from "./types";

/**
 * opencode, behind the same seam Codex sits behind.
 *
 * `backendFor("opencode")` used to throw. opencode was reachable, but only through
 * the parallel functions in opencode-deploy.ts — `planDeploy` and `agentRepair`
 * each branched on `agentName()` and called a different implementation. That worked
 * for two callers and stops working at three: chat would have needed its own branch
 * and its own copy of the event parsing, which is exactly the shape types.ts warns
 * about ("if any of that ends up implemented per-backend, the switch has cost more
 * than it bought").
 *
 * So the switch is real now for anything built on `runAgent`, and the loop detector,
 * the deadline and the event stream above the seam serve both engines.
 *
 * Two things this cannot do, and both are the interface being honest rather than
 * incomplete:
 *
 *   `structured()` returns null. opencode cannot constrain a final answer, which is
 *   documented in types.ts as the reason the field is optional — callers fall back
 *   to parsing prose. Chat has no schema, so it costs nothing here.
 *
 *   Provider selection is NOT re-implemented. opencodeConfig() picks between Vertex,
 *   the Gemini Developer API and OpenAI's Responses API for reasons worth reading
 *   (a reasoning model carries state between tool calls that the chat-completions
 *   shape has nowhere to put), and a second copy of that decision is the defect
 *   DEPLOY-PLAN.md is named after: one rule, two readers, and only one gets fixed.
 */
export class OpencodeBackend implements AgentBackend {
  readonly name = "opencode";

  /**
   * Running totals, per instance.
   *
   * opencode emits per-step DELTAS while the seam carries TOTALS, so the sum lives
   * on this side. Per INSTANCE and not per module: `backendFor` builds a fresh
   * backend per run, and chat runs concurrently — two people asking a question at
   * once would otherwise be billed each other's tokens.
   */
  private running = { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };

  async seed(spec: RunSpec): Promise<void> {
    // The config carries the provider credential, so it is fetched per run rather
    // than cached: a Vertex token has minutes of life and a stale one looks like a
    // model that does not exist.
    const token = await providerToken();
    writeFileSync(join(spec.ws, "opencode.json"), JSON.stringify(opencodeConfig(token), null, 2));
  }

  bin(): string {
    return opencodeBin();
  }

  argv(spec: RunSpec): string[] {
    return [
      "run",
      "--model",
      // opencode needs `<provider>/<model-id>`, which is the opposite of Codex —
      // it rejects the slash. `bareModel` strips it for Codex; this one wants the
      // full id, so it reads the environment rather than taking spec.model.
      process.env.OPENCODE_MODEL || `openai/${spec.model}`,
      "--auto",
      "--format",
      "json",
      spec.prompt,
    ];
  }

  env(spec: RunSpec): NodeJS.ProcessEnv {
    // A clean, explicit environment — never the parent's. See harness.ts: the
    // agent inherits nothing it was not handed on purpose.
    return {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TERM: "dumb",
      // opencode reads its config from the working directory, which seed() wrote.
      ...(spec.env ?? {}),
    } as NodeJS.ProcessEnv;
  }

  /**
   * One line of opencode's `--format json` stream → one normalised event.
   *
   * The shapes vary across versions, which is why each field is read from more than
   * one place: the deploy path learned that the hard way and this is the same
   * defensive read, not a guess.
   */
  parse(line: string): AgentEvent | null {
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      return null;
    }
    const type = o?.type;
    const part = o?.part ?? {};

    if (type === "tool_use" || type === "tool" || part?.type === "tool") {
      const name = part?.tool ?? o?.tool ?? part?.name;
      if (!name) return null;
      const input = part?.state?.input ?? o?.state?.input ?? {};
      const detail = input.command ?? input.filePath ?? input.pattern ?? "";
      return { kind: "tool", tool: { name: String(name), detail: String(detail) } };
    }

    if (type === "text" || type === "message" || part?.type === "text") {
      const text = part?.text ?? o?.text ?? part?.content;
      if (typeof text !== "string" || !text.trim()) return null;
      return { kind: "text", text };
    }

    if (type === "step_finish" || o?.tokens) {
      // opencode emits per-step DELTAS; the seam carries running TOTALS, so this is
      // where the two disagree and this side does the converting. types.ts is
      // explicit that a shared layer must never have to know which it is holding.
      const t = o?.tokens ?? {};
      const input = Number(t.input ?? 0);
      const output = Number(t.output ?? 0);
      const reasoning = Number(t.reasoning ?? 0);
      const cacheRead = Number(t.cache?.read ?? t.cacheRead ?? 0);
      const cacheWrite = Number(t.cache?.write ?? t.cacheWrite ?? 0);
      if (!input && !output && !reasoning) return null;
      const r = this.running;
      r.input += input;
      r.output += output;
      r.reasoning += reasoning;
      r.cacheRead += cacheRead;
      r.cacheWrite += cacheWrite;
      r.total = r.input + r.output + r.reasoning;
      return { kind: "usage", usage: { ...r } };
    }

    if (type === "error") {
      const error = o?.error?.message ?? o?.message ?? "opencode error";
      return { kind: "error", error: String(error) };
    }
    return null;
  }

  structured(): unknown | null {
    return null;
  }
}
