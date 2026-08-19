import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Everything that runs the agent must be Cloud Run gen2, and this is the check.
 *
 * `lib/agents/codex.ts` runs Codex with `--sandbox workspace-write`. On Linux
 * that sandbox is bubblewrap, which creates a network namespace and brings up
 * `lo` inside it. gen1 is gVisor and does not provide those namespaces, so the
 * netlink call returns `bwrap: loopback: Failed RTM_NEWADDR: No child process`
 * and NOTHING the agent asks for executes — not a tool, not `apply_patch`, not
 * `pwd`. The agent still reads the repo and still diagnoses it correctly, which
 * is what makes this so hard to see from the outside: it looks like a bad agent
 * rather than an agent with no shell.
 *
 * It has now happened twice. The control plane hit it on 19 Aug in chat and was
 * moved to gen2 the same afternoon; `supersonic-deploy-worker` — same image,
 * same pipeline, created a week earlier — was still gen1 and every repair it
 * attempted died the same way. The defect is not the missing flag. It is that
 * "all three of these are gen2" was held in three unrelated files by memory.
 *
 * So: read the files that create these resources and assert the flag is there.
 * A source-reading test cannot catch someone editing the live service by hand;
 * it catches the thing that actually happened, which is a new deploy site
 * written without a flag nobody remembered.
 */

const root = (p: string) => readFileSync(resolve(process.cwd(), "../..", p), "utf8");

/**
 * Comments are stripped before anything is asserted, and that is not fastidious:
 * every one of these deploy sites now carries a paragraph explaining the flag,
 * and a check that reads them would pass on the explanation alone — green
 * because the reason is written down, while the flag itself is gone.
 */
const uncommented = (s: string) =>
  s.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

/**
 * One step of cloudbuild.yaml, by id. Steps start at `- name:` at two spaces;
 * taking the whole step rather than a `gcloud …` line covers both forms this
 * file uses — an `args:` list (the control plane) and a bash heredoc (the
 * worker) — and a change from one to the other does not blind the test.
 */
function cloudbuildStep(id: string): string {
  const src = root("cloudbuild.yaml");
  const steps = src.split(/\n(?=  - name:)/);
  const step = steps.find((s) => new RegExp(`^\\s*id: ${id}\\s*$`, "m").test(s));
  assert.ok(step, `no step with id: ${id} in cloudbuild.yaml`);
  return uncommented(step);
}

/** One backslash-continued shell command, from `gcloud` to the first line that does not continue. */
function shellCommand(file: string, resource: string): string {
  const src = uncommented(root(file));
  const at = src.search(new RegExp(`gcloud run (?:deploy|jobs deploy) ${resource.replace(/[$"]/g, "\\$&")}`));
  assert.ok(at >= 0, `no gcloud run deploy of ${resource} in ${file}`);
  const lines = src.slice(at).split("\n");
  const end = lines.findIndex((l) => !l.trimEnd().endsWith("\\"));
  return lines.slice(0, end + 1).join("\n");
}

/** Every deploy of a resource that runs the agent image, and what to read for it. */
const AGENT_DEPLOYS: { what: string; deployed: string; command: () => string }[] = [
  {
    what: "cloudbuild.yaml (step `deploy`)",
    deployed: "supersonic-control-plane",
    command: () => cloudbuildStep("deploy"),
  },
  {
    what: "cloudbuild.yaml (step `deploy-worker`)",
    deployed: "supersonic-deploy-worker",
    command: () => cloudbuildStep("deploy-worker"),
  },
  {
    what: "scripts/setup-deploy-worker.sh",
    deployed: "supersonic-deploy-worker",
    command: () => shellCommand("scripts/setup-deploy-worker.sh", `"$WORKER"`),
  },
  {
    what: "scripts/setup-deploy-job.sh",
    deployed: "supersonic-deploy-job",
    command: () => shellCommand("scripts/setup-deploy-job.sh", `"$JOB"`),
  },
];

for (const { what, deployed, command } of AGENT_DEPLOYS) {
  test(`${what} deploys ${deployed} on gen2`, () => {
    const cmd = command();
    assert.ok(
      cmd.includes(deployed) || /\$(WORKER|JOB)/.test(cmd),
      `${what} no longer deploys ${deployed} — this test is reading the wrong thing`,
    );
    assert.ok(
      /--execution-environment[= ]gen2/.test(cmd),
      `${what} deploys ${deployed} without --execution-environment=gen2. ` +
        "That resource runs Codex, Codex sandboxes itself with bubblewrap, and " +
        "on gen1 every command it runs dies with `bwrap: loopback: Failed " +
        "RTM_NEWADDR: No child process`. See docs/HANDOFF-deploy-agent-sandbox.md.",
    );
    assert.ok(
      !/--execution-environment[= ]gen1/.test(cmd),
      `${what} pins ${deployed} to gen1 explicitly`,
    );
  });
}

/**
 * The other way to make the agent work, and the one not to take.
 *
 * `--sandbox danger-full-access` also ends the bwrap failures — by removing the
 * sandbox, which hands the agent's shell the network back. No network is the
 * whole reason a prompt injected through a deployed app's own database rows
 * cannot leave with anything it read. If this assertion ever fails, the gen2
 * requirement above has quietly been traded away rather than met.
 */
test("the agent keeps its sandbox", () => {
  const src = readFileSync(resolve(process.cwd(), "lib/agents/codex.ts"), "utf8");
  assert.match(src, /"--sandbox",\s*"workspace-write"/);
  assert.ok(
    !/danger-full-access/.test(src),
    "codex.ts asks for danger-full-access; see docs/HANDOFF-deploy-agent-sandbox.md §4",
  );
});
