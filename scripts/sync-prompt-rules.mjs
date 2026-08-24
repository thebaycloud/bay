#!/usr/bin/env node
/**
 * Copies packages/prompts/rules.ts into every app that needs it.
 *
 *   node scripts/sync-prompt-rules.mjs           write the copies
 *   node scripts/sync-prompt-rules.mjs --check   fail if a copy has drifted
 *
 * WHY A COPY AND NOT AN IMPORT
 *
 * apps/landing and apps/web are separate npm projects with separate Docker build
 * contexts. apps/landing/Dockerfile does `COPY . .` where `.` is apps/landing,
 * because it deploys with `gcloud run deploy --source` from that directory. A
 * path outside the app is therefore not in the image, so `import` of a shared
 * package, an fs read, and npm workspaces all fail identically at build time
 * while working fine on a laptop. That is the worst failure shape available: it
 * passes locally and breaks in Cloud Build.
 *
 * A committed copy inside each app is the one arrangement that survives the
 * existing deploy untouched. `--check` in CI is what makes it equivalent to a
 * real shared module: the copies cannot drift without the check going red.
 *
 * When the build context moves to the repo root, delete this script and import
 * packages/prompts directly.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "packages/prompts/rules.ts");

/** Every app that composes prompts. Add a line to bring another one in. */
const TARGETS = [
  "apps/landing/lib/prompt-rules.ts",
  "apps/web/lib/prompt-rules.ts",
];

const BANNER = `// GENERATED FILE. Do not edit.
//
// Source: packages/prompts/rules.ts
// Regenerate: node scripts/sync-prompt-rules.mjs
//
// A copy rather than an import because this app is built from its own directory
// as the Docker context, so a path outside it does not exist at build time. See
// the script for the full reasoning. \`--check\` keeps the copies honest.

`;

function expected() {
  if (!existsSync(SOURCE)) {
    console.error(`missing source: ${SOURCE}`);
    process.exit(1);
  }
  return BANNER + readFileSync(SOURCE, "utf8");
}

const want = expected();
const check = process.argv.includes("--check");
let drifted = 0;

for (const rel of TARGETS) {
  const path = join(ROOT, rel);
  const have = existsSync(path) ? readFileSync(path, "utf8") : null;

  if (have === want) {
    console.log(`  ok       ${rel}`);
    continue;
  }

  if (check) {
    console.error(`  DRIFTED  ${rel}${have === null ? " (missing)" : ""}`);
    drifted++;
    continue;
  }

  writeFileSync(path, want);
  console.log(`  ${have === null ? "created " : "updated "} ${rel}`);
}

if (check && drifted) {
  console.error(
    `\n${drifted} copy/copies out of date. Run: node scripts/sync-prompt-rules.mjs`
  );
  process.exit(1);
}
