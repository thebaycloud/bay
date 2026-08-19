import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ZERO_TOKENS, type AgentBackend, type AgentEvent, type RunSpec, type Tokens } from "./types";

/**
 * The Codex backend.
 *
 * Every flag here was established by running it, not by reading documentation —
 * `test/fixtures/codex-*.jsonl` are the recorded streams, and each of the four
 * traps below cost a failed run to find:
 *
 *   1. `codex exec` reads stdin when stdin is not closed, and prints "Reading
 *      additional input from stdin..." forever. The child gets `stdio[0]:
 *      "ignore"` in the harness. opencode has the identical trap and says so at
 *      `opencode-deploy.ts:757`.
 *   2. `OPENAI_API_KEY` in the environment is NOT read. Codex authenticates from
 *      `$CODEX_HOME/auth.json`, seeded by `codex login --with-api-key` over
 *      stdin. Without it every request is `401 Missing bearer` — from a key that
 *      works fine against the API directly.
 *   3. `model_providers.openai` cannot be overridden: "Built-in providers cannot
 *      be overridden." There is nothing to configure; the built-in is correct.
 *   4. An `--output-schema` must be STRICT. OpenAI structured outputs require
 *      `required` to list every key in `properties`; optionality is a nullable
 *      type, not an absent entry. A missing key fails the whole turn with
 *      `invalid_json_schema`.
 */

const BIN = process.env.CODEX_BIN || "codex";
const RESULT_FILE = "codex-result.json";

export class CodexBackend implements AgentBackend {
  readonly name = "codex";
  /** Per-run CODEX_HOME, so concurrent deploys never share auth or session state. */
  private homes = new Map<string, string>();
  private tokens: Tokens = { ...ZERO_TOKENS };

  private home(spec: RunSpec): string {
    let h = this.homes.get(spec.ws);
    if (!h) {
      h = mkdtempSync(join(tmpdir(), "ss-codex-"));
      this.homes.set(spec.ws, h);
    }
    return h;
  }

  async seed(spec: RunSpec): Promise<void> {
    // The system prompt. Codex has no `--agent`; AGENTS.md in the cwd is the
    // equivalent, and it is the file the CLI already looks for.
    writeFileSync(join(spec.ws, "AGENTS.md"), spec.instructions);

    if (spec.schema) {
      writeFileSync(join(spec.ws, "schema.json"), JSON.stringify(spec.schema, null, 2));
    }

    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is not set; codex cannot authenticate");

    // Seeded by subprocess rather than by writing auth.json directly: the file's
    // shape is Codex's to change, and `login` is the supported way to produce it.
    const home = this.home(spec);
    const r = spawnSync(BIN, ["login", "--with-api-key"], {
      input: key,
      env: { ...process.env, CODEX_HOME: home },
      encoding: "utf8",
    });
    if (r.status !== 0) {
      throw new Error(`codex login failed: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`);
    }
  }

  bin(): string {
    return BIN;
  }

  argv(spec: RunSpec): string[] {
    const a = [
      "exec",
      "--json",
      // We clone arbitrary repositories and many are not git working trees.
      // Without this Codex refuses to start at all.
      "--skip-git-repo-check",
      // Nothing on this box should outlive the run.
      "--ephemeral",
      "--ignore-user-config",
      "--sandbox", "workspace-write",
      "--model", spec.model,
      "--output-last-message", join(spec.ws, RESULT_FILE),
    ];
    if (spec.network) {
      // The repair agent must reach the redeploy bridge and run gcloud.
      a.push("-c", "sandbox_workspace_write.network_access=true");
    }
    if (spec.schema) {
      a.push("--output-schema", join(spec.ws, "schema.json"));
    }
    a.push(spec.prompt);
    return a;
  }

  env(spec: RunSpec): NodeJS.ProcessEnv {
    return {
      NODE_ENV: process.env.NODE_ENV || "production",
      HOME: homedir(),
      PATH: `/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}`,
      TMPDIR: tmpdir(),
      LANG: process.env.LANG || "en_US.UTF-8",
      USER: process.env.USER || "supersonic",
      CODEX_HOME: this.home(spec),
      ...spec.env,
    };
  }

  parse(line: string): AgentEvent | null {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      return null;
    }
    const type = o.type as string | undefined;

    if (type === "error") {
      return { kind: "error", error: String(o.message ?? "codex error") };
    }
    if (type === "turn.failed") {
      const e = o.error as { message?: string } | undefined;
      return { kind: "error", error: String(e?.message ?? "turn failed") };
    }
    if (type === "turn.completed") {
      const u = o.usage as Record<string, number> | undefined;
      if (!u) return null;
      // Codex reports cumulative totals for the turn. `Tokens` is defined as
      // totals for exactly this reason — see the note in types.ts.
      this.tokens = {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        reasoning: u.reasoning_output_tokens ?? 0,
        cacheRead: u.cached_input_tokens ?? 0,
        cacheWrite: u.cache_write_input_tokens ?? 0,
        total: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
      };
      return { kind: "usage", usage: { ...this.tokens } };
    }

    // Items. `started` and `completed` both arrive for the same id; only one of
    // them may be reported or every tool call is counted twice — and the loop
    // detector counts.
    if (type !== "item.started" && type !== "item.completed") return null;
    const item = (o.item ?? {}) as Record<string, unknown>;
    const itemType = item.type as string | undefined;

    if (itemType === "agent_message") {
      // Only on completion: the text is whole then.
      if (type !== "item.completed") return null;
      const text = String(item.text ?? "");
      return text.trim() ? { kind: "text", text } : null;
    }

    if (itemType === "command_execution") {
      // `started` is the CALL — that is what the loop detector counts. `completed`
      // is the RESULT, which used to be dropped entirely on the grounds that
      // reporting it would double every entry the detector sees. True, and the fix
      // is a separate kind rather than silence: without the exit code there is no
      // way to tell a tool that answered from one that could not run, which is
      // exactly the failure that then took an afternoon to find.
      if (type === "item.started") {
        return { kind: "tool", tool: { name: "bash", detail: cleanCommand(String(item.command ?? "")) } };
      }
      if (type === "item.completed") {
        const raw =
          item.aggregated_output ?? item.output ?? item.stdout ?? item.result ?? "";
        const code = item.exit_code;
        return {
          kind: "result",
          result: {
            name: "bash",
            exitCode: typeof code === "number" ? code : null,
            // Capped here rather than at the consumer: this is the one place that
            // knows the payload is a command's whole stdout, which for `./logs` is
            // as large as the app has been noisy.
            output: String(raw).slice(0, 4000),
          },
        };
      }
      return null;
    }

    if (itemType === "file_change") {
      if (type !== "item.started") return null;
      const changes = (item.changes ?? []) as { path?: string; kind?: string }[];
      const paths = changes.map((c) => relativise(String(c.path ?? ""))).filter(Boolean);
      return {
        kind: "tool",
        tool: { name: "edit", detail: paths.join(", "), editedPaths: paths },
      };
    }

    return null;
  }

  structured(spec: RunSpec): unknown | null {
    if (!spec.schema) return null;
    const p = join(spec.ws, RESULT_FILE);
    if (!existsSync(p)) return null;
    try {
      const raw = readFileSync(p, "utf8").trim();
      return raw ? JSON.parse(raw) : null;
    } catch {
      // A malformed final message is not fatal: the caller still has the text
      // stream to fall back on, exactly as it does for opencode.
      return null;
    }
  }
}

/**
 * Codex wraps every command in `/bin/zsh -lc "…"`. The wrapper is noise in a log
 * and, worse, it is IDENTICAL across calls — leaving it in makes two different
 * commands look the same to the loop detector for their first thirty characters.
 */
function cleanCommand(cmd: string): string {
  const m = cmd.match(/^\/bin\/(?:ba|z)?sh\s+-l?c\s+"?([\s\S]*?)"?$/);
  return (m ? m[1] : cmd).replace(/\s+/g, " ").trim();
}

/** `file_change` reports absolute paths; the `changes` set is repo-relative. */
function relativise(p: string): string {
  const i = p.lastIndexOf("/repo/");
  if (i >= 0) return p.slice(i + "/repo/".length);
  return p.replace(/^repo\//, "");
}
