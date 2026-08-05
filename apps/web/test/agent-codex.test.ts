import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexBackend } from "../lib/agents/codex";
import type { AgentEvent, RunSpec } from "../lib/agents/types";

/**
 * These run against RECORDED streams, not against a mock.
 *
 * `fixtures/codex-*.jsonl` came out of real `codex exec --json` runs against a
 * real repo. The event shape is not documented anywhere — it was established by
 * running it — so a test written from an invented stream would only prove that
 * the parser agrees with whoever wrote the test.
 *
 * If Codex changes its stream, these fail. That is the point: the plan commits
 * to keeping both backends satisfying one contract, and a switch nobody exercises
 * is a switch that is broken when you need it.
 */

function fixture(name: string): string[] {
  return readFileSync(resolve(import.meta.dirname, "fixtures", name), "utf8")
    .split("\n")
    .filter((l) => l.trim());
}

function parseAll(lines: string[]): AgentEvent[] {
  const b = new CodexBackend();
  return lines.map((l) => b.parse(l)).filter((e): e is AgentEvent => e !== null);
}

test("a planning run yields tool calls, the answer, and totals", () => {
  const events = parseAll(fixture("codex-plan.jsonl"));

  const tools = events.filter((e) => e.kind === "tool");
  assert.ok(tools.length >= 2, "the agent explored the repo");
  assert.ok(tools.every((t) => t.tool!.name === "bash"));

  // The zsh wrapper is stripped — with it, every command shares a 12-character
  // prefix and the loop detector cannot tell two apart.
  assert.ok(!tools.some((t) => t.tool!.detail.startsWith("/bin/")), "shell wrapper stripped");

  const text = events.filter((e) => e.kind === "text");
  assert.equal(text.length, 1, "one final message");
  assert.match(text[0].text!, /"language":"node"/);

  const usage = events.filter((e) => e.kind === "usage");
  assert.equal(usage.length, 1);
  assert.equal(usage[0].usage!.input, 48050);
  assert.equal(usage[0].usage!.output, 369);
  assert.equal(usage[0].usage!.cacheRead, 31709);
  assert.equal(usage[0].usage!.cacheWrite, 16332);
});

test("an edit run reports which files changed, repo-relative", () => {
  const events = parseAll(fixture("codex-edit.jsonl"));

  const edits = events.filter((e) => e.kind === "tool" && e.tool!.name === "edit");
  assert.equal(edits.length, 1, "file_change reported once, not once per status");
  assert.deepEqual(edits[0].tool!.editedPaths, ["index.js"]);
});

test("each tool call is reported exactly once", () => {
  // item.started and item.completed both arrive for the same id. Counting both
  // doubles every entry the loop detector sees, which halves the budget an agent
  // gets before it is killed for repeating itself.
  const lines = fixture("codex-edit.jsonl");
  const started = lines.filter((l) => JSON.parse(l).type === "item.started").length;
  const tools = parseAll(lines).filter((e) => e.kind === "tool").length;
  assert.equal(tools, started, "one event per item.started, none per item.completed");
});

test("a failed turn surfaces as an error, not as silence", () => {
  const b = new CodexBackend();
  const e = b.parse(JSON.stringify({ type: "turn.failed", error: { message: "401 Unauthorized" } }));
  assert.equal(e?.kind, "error");
  assert.match(e!.error!, /401/);
});

test("noise is dropped rather than thrown", () => {
  const b = new CodexBackend();
  assert.equal(b.parse("not json"), null);
  assert.equal(b.parse(JSON.stringify({ type: "thread.started", thread_id: "x" })), null);
  assert.equal(b.parse(JSON.stringify({ type: "turn.started" })), null);
});

test("the structured result is the plan itself, not a file the agent was asked to write", () => {
  const ws = mkdtempSync(join(tmpdir(), "ss-codex-test-"));
  const spec: RunSpec = {
    ws, prompt: "x", model: "m", instructions: "y", network: false,
    schema: { type: "object" },
  };
  const b = new CodexBackend();

  assert.equal(b.structured(spec), null, "absent before the run writes it");

  writeFileSync(join(ws, "codex-result.json"), '{"language":"node","static":false}');
  assert.deepEqual(b.structured(spec), { language: "node", static: false });

  // A malformed answer is not fatal — the caller still has the text stream.
  writeFileSync(join(ws, "codex-result.json"), "not json at all");
  assert.equal(b.structured(spec), null);
});

test("argv carries the flags that four failed runs established", () => {
  const b = new CodexBackend();
  const base: RunSpec = { ws: "/w", prompt: "p", model: "gpt-5.6-sol", instructions: "i", network: false };

  const plain = b.argv(base);
  assert.ok(plain.includes("--skip-git-repo-check"), "arbitrary repos are often not git trees");
  assert.ok(plain.includes("--json"));
  assert.ok(plain.includes("--ephemeral"));
  assert.equal(plain[plain.length - 1], "p", "the prompt is last");
  assert.ok(!plain.join(" ").includes("network_access"), "the planner needs no network");

  const online = b.argv({ ...base, network: true });
  assert.ok(online.join(" ").includes("sandbox_workspace_write.network_access=true"),
    "the repair agent must reach the redeploy bridge");

  const shaped = b.argv({ ...base, schema: { type: "object" } });
  assert.ok(shaped.includes("--output-schema"));
});
