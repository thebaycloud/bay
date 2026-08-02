import { test } from "node:test";
import assert from "node:assert/strict";

import { providerConfig } from "../lib/opencode-deploy";

const KEYS = { geminiApiKey: "g", openaiApiKey: "o", vertexToken: "t" };

/** The single provider block the config declares, plus the key it is filed under. */
function block(model: string, creds = KEYS) {
  const cfg = providerConfig(model, creds) as unknown as {
    provider: Record<string, { npm: string; options: { apiKey: string }; models: Record<string, unknown> }>;
  };
  const ids = Object.keys(cfg.provider);
  assert.equal(ids.length, 1, "exactly one provider may be declared");
  return { providerId: ids[0], ...cfg.provider[ids[0]] };
}

test("each provider is reached through the SDK that can carry its reasoning state", () => {
  // Not interchangeable. Both Gemini 3.x and OpenAI's reasoning models keep
  // state between tool calls that the chat-completions shape drops, which is
  // what breaks a repair loop on its second step rather than its first.
  assert.equal(block("google/gemini-3.1-pro").npm, "@ai-sdk/google");
  assert.equal(block("openai/gpt-5.6-sol").npm, "@ai-sdk/openai");
  assert.equal(block("vertex/google/gemini-2.5-pro").npm, "@ai-sdk/openai-compatible");
});

test("the model id keeps every segment after the provider", () => {
  // `vertex/google/gemini-2.5-pro` is a two-segment id, not a nested provider.
  assert.deepEqual(Object.keys(block("vertex/google/gemini-2.5-pro").models), ["google/gemini-2.5-pro"]);
  assert.deepEqual(Object.keys(block("openai/gpt-5.6-sol").models), ["gpt-5.6-sol"]);
});

test("an unknown provider falls back to vertex rather than inventing one", () => {
  assert.equal(block("gemini-2.5-pro").providerId, "vertex");
});

test("a provider selected without its key fails by name, not at the endpoint", () => {
  assert.throws(
    () => providerConfig("openai/gpt-5.6-sol", { ...KEYS, openaiApiKey: "" }),
    /OPENAI_API_KEY/,
  );
  assert.throws(
    () => providerConfig("google/gemini-3.1-pro", { ...KEYS, geminiApiKey: "" }),
    /GEMINI_API_KEY/,
  );
});

test("a key never travels to a provider that is not the one selected", () => {
  // The openai block carrying a Google token, or vice versa, would authenticate
  // against the wrong service and read back as "that model does not exist".
  const openai = block("openai/gpt-5.6-sol");
  assert.equal(openai.options.apiKey, "o");

  const google = block("google/gemini-3.1-pro");
  assert.equal(google.options.apiKey, "g");

  const vertex = block("vertex/google/gemini-2.5-pro");
  assert.equal(vertex.options.apiKey, "t");
});

test("only vertex needs a Google token at all", () => {
  // The repair agent has to be runnable where no Google credential exists.
  assert.doesNotThrow(() => providerConfig("openai/gpt-5.6-sol", { openaiApiKey: "o" }));
  assert.doesNotThrow(() => providerConfig("google/gemini-3.1-pro", { geminiApiKey: "g" }));
});

test("the repair agent is told what the platform did, not only what it planned", async () => {
  // Watched on a real Telegram bot: given `container failed to start and listen on
  // PORT=8080`, the agent began writing an `http.server` shim into a worker,
  // renamed a schema key it did not recognise, and replaced
  // `os.environ["BOT_TOKEN"]` with "dummy" so the process would boot.
  //
  // Every one of those is a sensible move for an agent that believes every app is
  // a web app and can only change the repo. The defect was context, not authority.
  const md = (await import("node:fs")).readFileSync(
    new URL("../lib/opencode-deploy.ts", import.meta.url), "utf8",
  );

  // The four facts that each turn a wrong edit into a correct diagnosis.
  assert.match(md, /serviceless: true[\s\S]*NO web process/);
  assert.match(md, /do not add an HTTP server/);
  assert.match(md, /runtime[\s\S]*only when the repo asked for a version it did not get/);
  assert.match(md, /ownedEnv[\s\S]*Editing one in the repo changes nothing/);

  // And the one edit that is never a fix, because it makes the failure invisible
  // rather than removing it.
  assert.match(md, /Never replace a credential with a literal/);
  assert.match(md, /makes the process start and the product silently not work/);
});
