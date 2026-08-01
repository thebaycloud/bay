/**
 * Compile the deploy-agent's stack detector into the CLI package.
 *
 * The CLI has to know what a project is before it can build it, and the control plane
 * has to know the same thing. A second implementation would drift within a month, and
 * the failure would be "the website says Vite, the CLI says Node" — the worst kind,
 * because both look right on their own. So there is one implementation, compiled here
 * into a file the CLI requires at runtime.
 *
 * Wired to prepublishOnly so a publish cannot ship a stale copy, and stamped so a
 * working copy cannot run one: the committed bundle spent two days answering
 * `python:3.12` after the source had moved to RUNTIME_VERSIONS, with nothing to say so.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { BUNDLES, STAMP_PREFIX, stampSources } from "./stamp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");
const repoRoot = resolve(cliRoot, "../..");
const agentSrc = resolve(repoRoot, "services/deploy-agent/src/index.ts");
const out = join(cliRoot, "vendor", "detector.js");

const stamp = stampSources(repoRoot, BUNDLES["detector.js"]);
mkdirSync(dirname(out), { recursive: true });

// esbuild ships with tsx, which the agent already depends on. Bundling to CommonJS so
// the CLI — which is CommonJS — can simply require() it.
execFileSync(
  "npx",
  [
    "--yes", "esbuild", agentSrc,
    "--bundle", "--platform=node", "--format=cjs", "--target=node20",
    "--legal-comments=none", `--banner:js=${STAMP_PREFIX}${stamp}`, `--outfile=${out}`,
  ],
  { stdio: "inherit", cwd: resolve(repoRoot, "services/deploy-agent") },
);

// The detector's CLI entry point runs on import when invoked directly; bundling keeps
// that behaviour out of our way because we only ever call the exported function.
writeFileSync(join(cliRoot, "vendor", "README.md"),
  "Generated. Do not edit — `npm run bundle` rebuilds both.\n\n" +
  "- detector.js — scripts/bundle-detector.mjs, from services/deploy-agent\n" +
  "- resolve.js  — scripts/bundle-resolver.mjs, from apps/web/lib (inputs listed in scripts/stamp.mjs)\n");

console.log(`detector bundled -> ${out}  (stamp ${stamp})`);
