import { test } from "node:test";
import assert from "node:assert/strict";
import { agentName, bareModel } from "../lib/agents";

/**
 * The switch itself. Small surface, and every case here is one somebody will hit
 * on an existing deployment.
 */

test("codex is the default, opencode is opt-in", () => {
  const prev = process.env.DEPLOY_AGENT;
  try {
    delete process.env.DEPLOY_AGENT;
    assert.equal(agentName(), "codex");

    process.env.DEPLOY_AGENT = "opencode";
    assert.equal(agentName(), "opencode");

    // Anything else is codex rather than a crash. A typo in an env var must not
    // take deploys down, and the default is the one we want.
    process.env.DEPLOY_AGENT = "openkode";
    assert.equal(agentName(), "codex");
  } finally {
    if (prev === undefined) delete process.env.DEPLOY_AGENT;
    else process.env.DEPLOY_AGENT = prev;
  }
});

test("the provider prefix is stripped for Codex", () => {
  // OPENCODE_MODEL is `<provider>/<model-id>` because opencode needs to know
  // which SDK to use, and it is set to `openai/gpt-5.6-sol` on every existing
  // deployment. Codex takes the bare id and rejects the slash, so passing the
  // same variable through untouched is a 400 on the first real deploy.
  assert.equal(bareModel("openai/gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(bareModel("gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(bareModel("vertex/gemini-3-pro"), "gemini-3-pro");
});

test("the write-a-file workaround is stripped for schema-capable backends", async () => {
  const { forSchemaBackend } = await import("../lib/agents");
  const { PLAN_AGENT_MD } = await import("../lib/opencode-deploy");

  const out = forSchemaBackend(PLAN_AGENT_MD);

  // Left in, a schema-capable backend does the work twice: on a real run the
  // agent wrote plan.json, then ran `cat plan.json`, then answered — two tool
  // calls spent on a file nothing reads, against a loop detector that counts.
  assert.ok(!/plan\.json/i.test(out), "no file path survives");
  assert.ok(!/WRITE the plan/i.test(out), "no write instruction survives");
  assert.match(out, /FINAL MESSAGE/, "it is told where the answer goes instead");

  // The rest of the prompt is the part that took work to get right. Losing it
  // would trade a small win for the planner's actual competence.
  assert.ok(out.length > PLAN_AGENT_MD.length * 0.7, "only the workaround is removed");
});
