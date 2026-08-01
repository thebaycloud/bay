/**
 * Compile the control plane's resolver into the CLI package.
 *
 * Same move as bundle-detector.mjs and for a sharper reason: `supersonic check`
 * is only worth running if it answers the question the server will answer. A
 * hand-ported copy of resolve.ts in JavaScript would agree on the day it was
 * written and disagree the first time a lane's consumes-list changed, and the
 * user-visible failure — check passes, the deploy resolves differently — is
 * indistinguishable from the platform being broken.
 *
 * Wired to prepublishOnly so a publish cannot ship a stale copy, and stamped so a
 * working copy cannot run one.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { BUNDLES, STAMP_PREFIX, stampSources } from "./stamp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");
const repoRoot = resolve(cliRoot, "../..");
const entry = join(cliRoot, "src", "resolver.entry.ts");
const out = join(cliRoot, "vendor", "resolve.js");

const stamp = stampSources(repoRoot, BUNDLES["resolve.js"]);
mkdirSync(dirname(out), { recursive: true });

// esbuild comes with tsx, which apps/web and services/deploy-agent both already
// depend on. CommonJS because the CLI is CommonJS and require() has to work out
// of a published tarball with no build step.
execFileSync(
  "npx",
  [
    "--yes", "esbuild", entry,
    "--bundle", "--platform=node", "--format=cjs", "--target=node20",
    "--legal-comments=none", `--banner:js=${STAMP_PREFIX}${stamp}`, `--outfile=${out}`,
  ],
  { stdio: "inherit", cwd: join(repoRoot, "apps/web") },
);

writeFileSync(join(cliRoot, "vendor", "README.md"),
  "Generated. Do not edit — `npm run bundle` rebuilds both.\n\n" +
  "- detector.js — scripts/bundle-detector.mjs, from services/deploy-agent\n" +
  "- resolve.js  — scripts/bundle-resolver.mjs, from apps/web/lib (inputs listed in scripts/stamp.mjs)\n");

console.log(`resolver bundled -> ${relative(repoRoot, out)}  (stamp ${stamp})`);
