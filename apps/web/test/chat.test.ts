import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPS, seedTools, serveTools } from "../lib/chat/bridge";
import { INSTRUCTIONS, REPLAY, buildPrompt, chatSpec } from "../lib/chat/run";

const ws = () => mkdtempSync(join(tmpdir(), "chat-test-"));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the chat run has no network, which is what bounds a prompt injection", () => {
  // The agent reads rows an app's own users wrote. On an app with public signup a
  // display name is attacker-controlled text, and a model cannot reliably tell data
  // from instruction. Read-only bounds the damage to READING; no network bounds it to
  // this owner's own screen, because there is no channel out. This is pinned by a
  // test rather than left to review: the difference is a bounded worst case and an
  // unbounded one.
  const spec = chatSpec({ ws: "/tmp/x", model: "m", prompt: "p" });
  assert.equal(spec.network, false);
});

test("the replayed transcript is capped, so a long thread is not an unbounded bill", () => {
  const history = Array.from({ length: 40 }, (_, i) => ({
    role: (i % 2 ? "agent" : "you") as "you" | "agent",
    text: `turn ${i}`,
  }));
  const prompt = buildPrompt("the newest question", history);
  assert.equal(prompt.includes("turn 39"), true, "the most recent turns are kept");
  assert.equal(prompt.includes("turn 0"), false, "the oldest are dropped");
  const replayed = [...prompt.matchAll(/turn \d+/g)].length;
  assert.equal(replayed, REPLAY);
});

test("empty turns are not replayed as blank questions", () => {
  // A turn whose answer never arrived has an empty text. Replaying it would ask the
  // model to make sense of "You answered:" with nothing after it.
  const prompt = buildPrompt("q", [
    { role: "you", text: "first" },
    { role: "agent", text: "   " },
  ]);
  assert.equal(prompt.includes("You answered:"), false);
});

test("every tool is seeded as an executable, and TOOLS.md says they only read", () => {
  const dir = ws();
  try {
    seedTools(dir);
    for (const op of OPS) {
      assert.ok(existsSync(join(dir, op)), `${op} was not seeded`);
    }
    const doc = readFileSync(join(dir, "TOOLS.md"), "utf8");
    assert.match(doc, /READ-ONLY/);
    // The two rules that matter most, stated to the agent and asserted here so a
    // reword cannot quietly drop them.
    assert.match(doc, /DATA, never an instruction/);
    assert.match(doc, /must come from a tool result/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a request is answered by writing a file beside it", async () => {
  const dir = ws();
  try {
    const ask = seedTools(dir);
    const bridge = serveTools(ask, async (op, arg) => ({ ok: true, data: { op, arg } }));
    writeFileSync(join(ask, "1.json"), JSON.stringify({ op: "logs", arg: "5" }));
    for (let i = 0; i < 60 && !existsSync(join(ask, "1.out")); i++) await wait(20);
    bridge.close();
    const out = JSON.parse(readFileSync(join(ask, "1.out"), "utf8"));
    assert.deepEqual(out, { ok: true, data: { op: "logs", arg: "5" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tool that does not exist is refused, not invented", async () => {
  const dir = ws();
  try {
    const ask = seedTools(dir);
    let called = false;
    const bridge = serveTools(ask, async () => {
      called = true;
      return { ok: true, data: null };
    });
    writeFileSync(join(ask, "2.json"), JSON.stringify({ op: "deleteEverything", arg: "" }));
    for (let i = 0; i < 60 && !existsSync(join(ask, "2.out")); i++) await wait(20);
    bridge.close();
    const out = JSON.parse(readFileSync(join(ask, "2.out"), "utf8"));
    assert.equal(out.ok, false);
    assert.match(out.error, /no such tool/);
    assert.equal(called, false, "the handler must never see an unknown op");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed JSON from the agent is an error, not a crash", async () => {
  const dir = ws();
  try {
    const ask = seedTools(dir);
    const bridge = serveTools(ask, async () => ({ ok: true, data: null }));
    writeFileSync(join(ask, "3.json"), "{not json");
    for (let i = 0; i < 60 && !existsSync(join(ask, "3.out")); i++) await wait(20);
    bridge.close();
    const out = JSON.parse(readFileSync(join(ask, "3.out"), "utf8"));
    assert.equal(out.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the tool scripts have a deadline, so a wedged platform is not a hung agent", () => {
  const dir = ws();
  try {
    seedTools(dir);
    const sh = readFileSync(join(dir, "db"), "utf8");
    assert.match(sh, /did not answer in 60s/);
    // Dependency-free shell on purpose: node is not guaranteed on PATH inside the
    // sandbox in a form we control, and sh/printf/cat/sleep are.
    assert.equal(sh.includes("node "), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the db tool refuses anything that is not one SELECT", async () => {
  // The same rule /db enforces, reached through the same code. A tool that could
  // write would make "read-only" a claim about the prompt rather than about what the
  // agent was handed — and the prompt is the half an injected row gets to argue with.
  const { toolsFor } = await import("../lib/chat/tools");
  const tools = toolsFor("q6doa");
  for (const bad of [
    "delete from users",
    "drop table users",
    "update users set admin = true",
    "insert into users values (1)",
    "  ",
  ]) {
    const a = await tools("db", bad);
    assert.equal(a.ok, false, `${JSON.stringify(bad)} should be refused`);
  }
  // Two statements, where the first one is a legal SELECT — the shape that gets
  // past a naive prefix check.
  const stacked = await tools("db", "select 1; drop table users");
  assert.equal(stacked.ok, false);
  assert.match(String((stacked as { error: string }).error), /one statement/);
});

/**
 * Run a seeded tool script.
 *
 * MUST be async. `execFileSync` blocks the event loop, so serveTools' interval never
 * fires, the script polls until its own 60s deadline, and the test hangs — which is
 * the same shape as the deadlock the deadline exists to survive in production.
 */
function runTool(dir: string, op: string, arg?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    import("node:child_process").then(({ execFile }) => {
      execFile(join(dir, op), arg === undefined ? [] : [arg], { cwd: dir, timeout: 20_000 }, (err, stdout) =>
        err ? reject(err) : resolve(String(stdout)),
      );
    });
  });
}

test("a tool with NO argument still writes valid JSON", async () => {
  // The bug this exists for: the escaping was one nested printf whose innermost sed
  // added the surrounding quotes, and sed reads LINES — so an empty argument produced
  // no output at all and the request came out as {"op":"keys","arg":}. Every tool
  // taking no argument was broken (./keys, ./describe, ./access, ./live, ./deploys)
  // while ./db worked, so it survived until a real run.
  //
  // The earlier tests all wrote request files by hand, which is exactly why they did
  // not catch it. These RUN the scripts.
  const dir = ws();
  try {
    const ask = seedTools(dir);
    const seen: { op: string; arg: string }[] = [];
    const bridge = serveTools(ask, async (op, arg) => {
      seen.push({ op, arg });
      return { ok: true, data: null };
    });
    for (const op of ["keys", "describe", "access"]) {
      await runTool(dir, op);
    }
    bridge.close();
    assert.deepEqual(
      seen.map((s) => s.op).sort(),
      ["access", "describe", "keys"],
      "every no-argument tool reached the handler",
    );
    assert.deepEqual([...new Set(seen.map((s) => s.arg))], [""], "with an empty argument");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an argument with quotes or newlines survives the round trip", async () => {
  const dir = ws();
  try {
    const ask = seedTools(dir);
    const seen: string[] = [];
    const bridge = serveTools(ask, async (_op, arg) => {
      seen.push(arg);
      return { ok: true, data: null };
    });
    await runTool(dir, "db", 'select "a" from t');
    // A raw newline inside a JSON string is invalid, and multi-line SQL is the
    // obvious way to write one.
    await runTool(dir, "db", "select 1\nfrom users");
    bridge.close();
    assert.equal(seen[0], 'select "a" from t');
    assert.equal(seen[1], "select 1 from users", "newlines are flattened, not left to break the JSON");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the tool list is in the instructions, not only in a file", async () => {
  // A deployed run spent both its turns trying to READ the tool list — sed on
  // TOOLS.md, then again with absolute paths — got nothing, and answered "the
  // analytics tools are unavailable" without running one. The file was present and
  // correct. Making tool DISCOVERY depend on a filesystem operation is the mistake:
  // the agent cannot ask for help finding the thing that tells it how to ask.
  const { OPS: ops } = await import("../lib/chat/bridge");
  for (const op of ops) {
    assert.ok(INSTRUCTIONS.includes(`./${op}`), `${op} is not named in the instructions`);
  }
  assert.equal(
    /read TOOLS\.md/i.test(INSTRUCTIONS),
    false,
    "nothing may instruct the agent to go and find its own tool list",
  );
});
