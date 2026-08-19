import { spawn } from "node:child_process";
import { ZERO_TOKENS, type AgentBackend, type AgentEvent, type RunSpec, type Tokens } from "./types";

/**
 * The run loop both backends sit under.
 *
 * Everything here exists because of something that happened, and none of it is
 * a property of which CLI is driving:
 *
 *   - **The loop detector.** A stuck agent looks exactly like a working one from
 *     out here — it keeps making tool calls and the timeout keeps not firing. One
 *     Go repo spent an entire 240s budget running `ls -F repo/`, and a Flask
 *     deploy did the same thing sixteen times before recovering. Waiting out the
 *     full timeout for a loop that will never converge costs four minutes of a
 *     deploy that has five.
 *   - **Not saying anything twice.** The agent re-reads the same file and
 *     re-lists the same directory constantly, and printing every repeat is how a
 *     successful deploy came to show the identical line eight times and read as
 *     a malfunction.
 *   - **A closed stdin.** Both CLIs block forever waiting on stdin EOF otherwise.
 *   - **An allowlisted environment.** Launched under npm and a Next.js runtime,
 *     the parent env carries `npm_` variables, NODE_OPTIONS and loader hooks that
 *     poison the child processes these CLIs spawn, surfacing only as an opaque
 *     "Unexpected server error". Blocklisting each offender did not work; an
 *     allowlist does.
 *
 * Killing a looping agent is not the same as giving up. Whatever it had already
 * produced — a written file, a structured answer — is read afterwards either way,
 * so an agent that finished its work and then started wandering still delivers.
 */

export interface RunResult {
  /** Everything the agent said, in order, for callers that must parse prose. */
  text: string;
  /** Repo-relative paths the agent wrote. */
  changes: string[];
  tokens: Tokens;
  /** Tool calls observed — the closest thing to "steps". */
  steps: number;
  /** The first error the backend reported, if any. */
  error: string | null;
  /** Why the run ended, for the log and for tests. */
  ended: "exit" | "timeout" | "looping" | "spawn-failed";
}

export interface RunOptions {
  backend: AgentBackend;
  spec: RunSpec;
  log: (line: string) => void;
  /** Prefix on every log line: `planner` or `agent`. */
  label: string;
  timeoutMs: number;
  /** Tool calls before we assume it is not converging. */
  maxCalls?: number;
  /** Identical calls before we assume it is stuck. */
  repeatsAllowed?: number;
  /**
   * Every normalised event, as it happens.
   *
   * `log` is a line of prose for a deploy log — it summarises, it dedupes, and it
   * throws the structure away. A chat rail needs the structure: a tool call with
   * its name and argument, prose separately, a token total. The harness already
   * builds exactly that on the way to `log`, so this hands it over rather than
   * asking a caller to parse the sentence back apart.
   *
   * Above the backend seam on purpose. types.ts says shared behaviour lives here,
   * and an event stream that each backend exposed its own way would be the first
   * crack in it.
   */
  onEvent?: (e: AgentEvent) => void;
}

export async function runAgent(o: RunOptions): Promise<RunResult> {
  const { backend, spec, log, label } = o;
  const maxCalls = o.maxCalls ?? 40;
  const repeatsAllowed = o.repeatsAllowed ?? 3;

  await backend.seed(spec);

  const result: RunResult = {
    text: "", changes: [], tokens: { ...ZERO_TOKENS },
    steps: 0, error: null, ended: "exit",
  };
  const changes = new Set<string>();
  const calls = new Map<string, number>();

  await new Promise<void>((resolve) => {
    const p = spawn(backend.bin(), backend.argv(spec), {
      cwd: spec.ws,
      // stdin closed. See the note above; both CLIs hang without it.
      stdio: ["ignore", "pipe", "pipe"],
      env: backend.env(spec),
    });

    let settled = false;
    const done = (why: RunResult["ended"]) => {
      if (settled) return;
      settled = true;
      result.ended = why;
      resolve();
    };

    const killer = setTimeout(() => {
      log(`${label} · timed out`);
      try { p.kill("SIGKILL"); } catch { /* already gone */ }
      done("timeout");
    }, o.timeoutMs);

    const stop = (why: string) => {
      log(`${label} · ${why}`);
      try { p.kill("SIGKILL"); } catch { /* already gone */ }
      done("looping");
    };

    let lastSaid = "";
    const say = (line: string) => {
      if (line === lastSaid) return;
      lastSaid = line;
      log(line);
    };

    const onEvent = (e: AgentEvent) => {
      // Handed over before any of the harness's own bookkeeping, so a caller sees
      // what the backend actually said — including the events `say` dedupes away.
      o.onEvent?.(e);
      if (e.kind === "tool" && e.tool) {
        result.steps++;
        for (const path of e.tool.editedPaths ?? []) changes.add(path);
        say(`${label} · ${describe(e.tool.name, e.tool.detail)}`);

        const key = `${e.tool.name}:${e.tool.detail}`;
        const n = (calls.get(key) ?? 0) + 1;
        calls.set(key, n);
        if (result.steps > maxCalls) stop(`explored ${maxCalls} times without deciding — stopping it`);
        else if (n > repeatsAllowed) stop(`repeating \`${key.slice(0, 60)}\` — stopping it`);
        return;
      }
      if (e.kind === "result" && e.result) {
        // Deliberately NOT counted and NOT fed to the loop detector: this is the same
        // call the `tool` event already counted. It is logged, because a non-zero exit
        // is the single most useful line in a failed run and was previously invisible.
        const { name, exitCode, output } = e.result;
        if (exitCode !== null && exitCode !== 0) {
          const first = output.trim().split("\n")[0] ?? "";
          say(`${label} · ${name} exited ${exitCode}${first ? `: ${first.slice(0, 160)}` : ""}`);
        }
        return;
      }
      if (e.kind === "text" && e.text) {
        // ALL text accumulates for parsing; only a first sentence is shown.
        // Slicing at a fixed width cut narration off mid-word ("plan.jso",
        // "This s") and looked like the process had died.
        result.text += e.text + "\n";
        const flat = e.text.trim().replace(/\s+/g, " ");
        const sentence = flat.split(/(?<=[.!?])\s/)[0] ?? flat;
        say(`${label} · ${sentence.length > 140 ? sentence.slice(0, 137).replace(/\s+\S*$/, "") + "…" : sentence}`);
        return;
      }
      if (e.kind === "usage" && e.usage) {
        // Totals, not increments — see types.ts.
        result.tokens = e.usage;
        return;
      }
      if (e.kind === "error" && e.error) {
        // The FIRST error is kept. Later ones are usually consequences of it,
        // and reporting the last leaves the user reading a symptom.
        if (!result.error) result.error = e.error;
        log(`${label} error: ${e.error.slice(0, 200)}`);
      }
    };

    let buf = "";
    p.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const e = backend.parse(line);
        if (e) onEvent(e);
      }
    });
    p.stderr.on("data", (d: Buffer) => {
      const l = d.toString().trim();
      if (l) log(`${label}: ${l.slice(0, 160)}`);
    });
    p.on("error", (e) => {
      result.error = e.message;
      log(`${label} spawn failed: ${e.message}`);
      clearTimeout(killer);
      done("spawn-failed");
    });
    p.on("close", () => {
      clearTimeout(killer);
      done("exit");
    });
  });

  result.changes = [...changes];
  return result;
}

/** A tool call as a person would say it. */
function describe(name: string, detail: string): string {
  const d = detail.length > 70 ? detail.slice(0, 67) + "…" : detail;
  if (name === "edit") return `edit ${d}`;
  if (name === "bash") return d || "bash";
  return d ? `${name} ${d}` : name;
}
