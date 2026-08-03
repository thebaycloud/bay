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
 * working copy cannot run one. The stamp now covers whatever esbuild actually
 * pulled in rather than a list somebody kept up to date by hand; see stamp.mjs.
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
const entry = join(cliRoot, "src", "resolver.entry.ts");
const out = join(cliRoot, "vendor", "resolve.js");
const esbuildCwd = join(repoRoot, "apps/web");

mkdirSync(dirname(out), { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "supersonic-bundle-"));
const metaPath = join(scratch, "resolve.meta.json");

// esbuild comes with tsx, which apps/web and services/deploy-agent both already
// depend on. CommonJS because the CLI is CommonJS and require() has to work out
// of a published tarball with no build step.
//
// The stamp cannot be a `--banner:js` any more: it is computed FROM this run's
// metafile, so it does not exist until the run is over. It is prepended below.
try {
  execFileSync(
    "npx",
    [
      "--yes", "esbuild", entry,
      "--bundle", "--platform=node", "--format=cjs", "--target=node20",
      "--legal-comments=none", `--metafile=${metaPath}`, `--outfile=${out}`,
    ],
    { stdio: "inherit", cwd: esbuildCwd },
  );

  const sources = repoInputs(JSON.parse(readFileSync(metaPath, "utf8")), esbuildCwd, repoRoot);
  const stamp = stampSources(repoRoot, sources);
  writeInputs(cliRoot, "resolve.js", sources);
  prependStamp(out, stamp);

  writeFileSync(join(cliRoot, "vendor", "README.md"),
    "Generated. Do not edit — `npm run bundle` rebuilds all of it.\n\n" +
    "- detector.js — scripts/bundle-detector.mjs, from services/deploy-agent\n" +
    "- resolve.js  — scripts/bundle-resolver.mjs, from apps/web/lib\n" +
    "- inputs.json — every repository file esbuild inlined into each bundle, from its metafile.\n" +
    "                test/vendor.test.js hashes these to prove the bundles are not stale.\n");

  console.log(`resolver bundled -> ${relative(repoRoot, out)}  (stamp ${stamp}, ${sources.length} inputs -> ${INPUTS_PATH})`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
