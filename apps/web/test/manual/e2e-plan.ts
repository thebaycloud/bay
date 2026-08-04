/**
 * Not part of the suite. Runs the real planner against a real repo and prints
 * the plan, so a backend can be checked end to end without a deploy:
 *
 *   OPENAI_API_KEY=… DEPLOY_AGENT=codex \
 *     node --import tsx test/manual/e2e-plan.ts ../../examples/pgapp
 */
import { planDeploy, agentName } from "../../lib/agents";

const dir = process.argv[2];
if (!dir) { console.error("usage: e2e-plan.ts <repo-dir>"); process.exit(2); }

const t0 = Date.now();
console.log(`backend: ${agentName()}`);
planDeploy({ dir, log: (l) => console.log("   " + l) })
  .then((p) => {
    console.log(`\n=== PLAN (${((Date.now() - t0) / 1000).toFixed(1)}s) ===`);
    console.log(JSON.stringify(p, null, 2));
  })
  .catch((e) => { console.log(`FAILED: ${e?.name}: ${e?.message}`); process.exit(1); });
