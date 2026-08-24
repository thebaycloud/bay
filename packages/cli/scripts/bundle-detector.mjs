/**
 * Compile the stack detector into the CLI package.
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
 * The stamp's inputs come from esbuild's metafile now; see stamp.mjs.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { INPUTS_PATH, prependStamp, repoInputs, stampSources, writeInputs } from "./stamp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");
const repoRoot = resolve(cliRoot, "../..");
const agentSrc = resolve(repoRoot, "packages/detector/src/index.ts");
const out = join(cliRoot, "vendor", "detector.js");
const esbuildCwd = resolve(repoRoot, "packages/detector");

mkdirSync(dirname(out), { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "supersonic-bundle-"));
const metaPath = join(scratch, "detector.meta.json");

// esbuild ships with tsx, which the agent already depends on. Bundling to CommonJS so
// the CLI — which is CommonJS — can simply require() it.
try {
  execFileSync(
    "npx",
    [
      "--yes", "esbuild", agentSrc,
      "--bundle", "--platform=node", "--format=cjs", "--target=node20",
      "--legal-comments=none", `--metafile=${metaPath}`, `--outfile=${out}`,
    ],
    { stdio: "inherit", cwd: esbuildCwd },
  );

  const sources = repoInputs(JSON.parse(readFileSync(metaPath, "utf8")), esbuildCwd, repoRoot);
  const stamp = stampSources(repoRoot, sources);
  writeInputs(cliRoot, "detector.js", sources);
  prependStamp(out, stamp);

  // The detector's CLI entry point runs on import when invoked directly; bundling keeps
  // that behaviour out of our way because we only ever call the exported function.
  writeFileSync(join(cliRoot, "vendor", "README.md"),
    "Generated. Do not edit — `npm run bundle` rebuilds all of it.\n\n" +
    "- detector.js — scripts/bundle-detector.mjs, from packages/detector\n" +
    "- resolve.js  — scripts/bundle-resolver.mjs, from apps/web/lib\n" +
    "- inputs.json — every repository file esbuild inlined into each bundle, from its metafile.\n" +
    "                test/vendor.test.js hashes these to prove the bundles are not stale.\n");

  console.log(`detector bundled -> ${relative(repoRoot, out)}  (stamp ${stamp}, ${sources.length} inputs -> ${INPUTS_PATH})`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
