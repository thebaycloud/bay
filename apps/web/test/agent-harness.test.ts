import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../lib/agents/harness";
import type { AgentBackend, AgentEvent, RunSpec } from "../lib/agents/types";

/**
 * The harness is tested with a FAKE backend that replays a scripted stream.
 *
 * Everything under test here — the loop detector, the repeat suppression, the
 * accumulation — exists because of a real incident, and none of it depends on
 * which CLI is driving. Testing it through a real CLI would make these tests
 * slow, networked, and about the wrong thing.
 */

/** A backend that emits fixed lines from a script the test controls. */
function fakeBackend(lines: string[]): AgentBackend {
  return {
    name: "fake",
    async seed() {},
    bin() {
      // `printf` rather than `echo`: portable, and one process per run.
      return "/bin/sh";
    },
    argv() {
      const script = lines.map((l) => `printf '%s\\n' ${JSON.stringify(l)}`).join("; ");
      return ["-c", script];
    },
    env() {
      return { NODE_ENV: "test", PATH: "/usr/bin:/bin" };
    },
    parse(line: string): AgentEvent | null {
      try {
        return JSON.parse(line) as AgentEvent;
      } catch {
        return null;
      }
    },
    structured() {
      return null;
    },
  };
}

const spec = (): RunSpec => ({
  ws: mkdtempSync(join(tmpdir(), "ss-harness-")),
  prompt: "p", model: "m", instructions: "i", network: false,
});

const tool = (name: string, detail: string, editedPaths?: string[]) =>
  JSON.stringify({ kind: "tool", tool: { name, detail, editedPaths } });

test("accumulates text, changes and totals", async () => {
  const r = await runAgent({
    backend: fakeBackend([
      tool("bash", "ls repo"),
      tool("edit", "index.js", ["index.js"]),
      tool("edit", "app.py", ["app.py"]),
      JSON.stringify({ kind: "text", text: "Done." }),
      JSON.stringify({ kind: "usage", usage: { total: 9, input: 5, output: 4, reasoning: 1, cacheRead: 2, cacheWrite: 3 } }),
    ]),
    spec: spec(), log: () => {}, label: "t", timeoutMs: 20000,
  });

  assert.equal(r.ended, "exit");
  assert.match(r.text, /Done\./);
  assert.deepEqual(r.changes.sort(), ["app.py", "index.js"]);
  assert.equal(r.tokens.input, 5);
  assert.equal(r.steps, 3);
  assert.equal(r.error, null);
});

test("usage replaces rather than accumulates", async () => {
  // Codex reports cumulative totals per turn. Summing them would double-count.
  const r = await runAgent({
    backend: fakeBackend([
      JSON.stringify({ kind: "usage", usage: { total: 10, input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }),
      JSON.stringify({ kind: "usage", usage: { total: 25, input: 25, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }),
    ]),
    spec: spec(), log: () => {}, label: "t", timeoutMs: 20000,
  });
  assert.equal(r.tokens.input, 25, "the last snapshot wins");
});

test("kills an agent repeating one call", async () => {
  const logs: string[] = [];
  const r = await runAgent({
    backend: fakeBackend(Array(10).fill(tool("bash", "ls -F repo/"))),
    spec: spec(), log: (l) => logs.push(l), label: "planner", timeoutMs: 20000,
    repeatsAllowed: 3,
  });

  assert.equal(r.ended, "looping");
  assert.ok(logs.some((l) => /repeating/.test(l)), "says why it stopped");
});

test("kills an agent that explores without deciding", async () => {
  const r = await runAgent({
    // All distinct, so only the total budget can stop it.
    backend: fakeBackend(Array(30).fill(0).map((_, i) => tool("bash", `cat file-${i}`))),
    spec: spec(), log: () => {}, label: "planner", timeoutMs: 20000,
    maxCalls: 10, repeatsAllowed: 99,
  });
  assert.equal(r.ended, "looping");
});

test("does not print the same line twice in a row", async () => {
  const logs: string[] = [];
  await runAgent({
    // Under the repeat limit, so the run completes — this is about the log.
    backend: fakeBackend([tool("bash", "ls"), tool("bash", "ls"), tool("bash", "pwd")]),
    spec: spec(), log: (l) => logs.push(l), label: "t", timeoutMs: 20000,
    repeatsAllowed: 5,
  });
  const ls = logs.filter((l) => l.endsWith("ls"));
  assert.equal(ls.length, 1, "the repeat is suppressed");
});

test("keeps the FIRST error, not the last", async () => {
  // Later errors are usually consequences; reporting the last leaves the user
  // reading a symptom.
  const r = await runAgent({
    backend: fakeBackend([
      JSON.stringify({ kind: "error", error: "401 Unauthorized" }),
      JSON.stringify({ kind: "error", error: "turn failed" }),
    ]),
    spec: spec(), log: () => {}, label: "t", timeoutMs: 20000,
  });
  assert.match(r.error!, /401/);
});

test("a timeout ends the run rather than hanging", async () => {
  const backend = fakeBackend([]);
  const slow: AgentBackend = { ...backend, argv: () => ["-c", "sleep 30"] };
  const started = Date.now();
  const r = await runAgent({
    backend: slow, spec: spec(), log: () => {}, label: "t", timeoutMs: 1500,
  });
  assert.equal(r.ended, "timeout");
  assert.ok(Date.now() - started < 10000, "did not wait for the child");
});

test("a missing binary is reported, not thrown", async () => {
  const backend = fakeBackend([]);
  const missing: AgentBackend = { ...backend, bin: () => "/nonexistent/agent-binary" };
  const r = await runAgent({
    backend: missing, spec: spec(), log: () => {}, label: "t", timeoutMs: 5000,
  });
  assert.equal(r.ended, "spawn-failed");
  assert.ok(r.error);
});
