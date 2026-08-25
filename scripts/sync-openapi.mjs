#!/usr/bin/env node
/**
 * Renders packages/openapi/spec.mjs into every app that serves it.
 *
 *   node scripts/sync-openapi.mjs           write the copies
 *   node scripts/sync-openapi.mjs --check   fail if a copy has drifted
 *
 * The same arrangement, and the same reason, as scripts/sync-prompt-rules.mjs:
 * apps/landing and apps/web are separate Docker build contexts, so a file
 * outside the app does not exist at build time. Read that script's comment for
 * the full argument.
 *
 * TWO COPIES, ON PURPOSE
 *
 * `app.thebay.cloud/openapi.json` is where the API describes itself, which is
 * the address a client that already has a response will look. `thebay.cloud/
 * openapi.json` is where somebody who has only the brand will look, and it is
 * the host every agent-readability check scans. Neither is redundant; a spec
 * reachable only from the API is a spec you have to have found the API to find.
 *
 * Stable key order, because JSON.stringify of a hand-written object is stable
 * but a reordered source would otherwise produce a diff that says nothing.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spec } from "../packages/openapi/spec.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every app that serves the description. Add a line to bring another one in. */
const TARGETS = ["apps/web/public/openapi.json", "apps/landing/public/openapi.json"];

const want = JSON.stringify(spec, null, 2) + "\n";
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
    console.error(`  DRIFTED  ${rel}`);
    drifted++;
    continue;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, want);
  console.log(`  wrote    ${rel}`);
}

if (drifted) {
  console.error(`\n${drifted} copy/copies are out of date. Run: node scripts/sync-openapi.mjs`);
  process.exit(1);
}
