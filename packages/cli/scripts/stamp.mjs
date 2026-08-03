/**
 * A fingerprint of the sources a vendored bundle was built from.
 *
 * Written into the bundle's first line at build time and checked by
 * test/vendor.test.js, so a checkout whose `vendor/*.js` is older than the
 * TypeScript it came from fails a test instead of shipping.
 *
 * This is not hypothetical. The committed vendor/detector.js was built on 30 Jul
 * and still contained `runtime: "python:3.12"` — the literal that plan-deps.ts
 * had already replaced with RUNTIME_VERSIONS because building a
 * `requires-python >= 3.14` app on 3.12 fails at pip with a message blaming the
 * app. prepublishOnly regenerates the bundles, so the wrong number could only
 * ever have reached a user through a publish; it reached every local `supersonic
 * deploy` immediately, and nothing said so.
 *
 * WHY THE INPUT LIST IS NO LONGER WRITTEN BY HAND
 *
 * It used to be a literal here: seven filenames for resolve.js, two for
 * detector.js. esbuild inlines the whole import graph, and the graph was already
 * larger than the list — repo-runtime.ts, procfile.ts, processes.ts and
 * process-plan.ts are all bundled and none of them were named. So the guarantee
 * this file exists to give had a hole in exactly the shape of the bug it was
 * written for: rewrite repo-runtime.ts, and the stamp does not move, and the test
 * stays green on a bundle built from the old rules.
 *
 * A hand-maintained list of a machine-derived set drifts the moment someone adds
 * an import, and nothing tells them. So the list is now esbuild's own answer —
 * `--metafile`, filtered to the files that live in this repository — recorded in
 * `vendor/inputs.json` beside the bundles it describes. Adding a file to the
 * graph means editing a file already in it, which moves the stamp, which fails
 * the test, which rebuilds both. The loop closes with nobody remembering
 * anything.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const STAMP_PREFIX = "// supersonic-vendor-stamp ";

/** Where the derived input lists live, relative to packages/cli. */
export const INPUTS_PATH = join("vendor", "inputs.json");

/**
 * The repository files esbuild actually inlined, from its own metafile.
 *
 * Keys in `metafile.inputs` are relative to the directory esbuild ran in, which
 * is not the repo root for either bundler. Everything is resolved through that
 * cwd and then expressed repo-relative, so the list means the same thing on any
 * machine.
 *
 * `node_modules` is dropped deliberately. It is not committed, so it cannot be
 * the thing that went stale — package-lock.json is what pins it — and hashing a
 * dependency tree would make the stamp move on an unrelated `npm install`.
 */
export function repoInputs(metafile, esbuildCwd, repoRoot) {
  const seen = new Set();
  for (const key of Object.keys(metafile.inputs ?? {})) {
    // esbuild namespaces virtual modules as `plugin:whatever`; those are not files.
    if (key.includes(":") && !key.startsWith(".") && !key.startsWith("/")) continue;
    const abs = resolve(esbuildCwd, key);
    const rel = relative(repoRoot, abs);
    if (!rel || rel.startsWith("..")) continue;                 // outside the repo
    if (rel.split(sep).includes("node_modules")) continue;      // pinned by the lockfile
    seen.add(rel.split(sep).join("/"));
  }
  return [...seen].sort();
}

/** One hash over every input, so an edit to any of them invalidates the bundle. */
export function stampSources(repoRoot, sources) {
  const h = createHash("sha256");
  for (const rel of sources) {
    let body;
    try {
      body = readFileSync(join(repoRoot, rel));
    } catch (e) {
      // A recorded input that no longer exists means the graph changed without a
      // rebuild — the same staleness the stamp is for, said in the one case where
      // hashing cannot say it.
      throw new Error(
        `vendor/inputs.json lists ${rel}, which is not in the checkout — ` +
        `run \`npm run bundle\` in packages/cli (${e.code ?? e.message})`,
      );
    }
    h.update(rel).update("\0").update(body);
  }
  return h.digest("hex").slice(0, 16);
}

/** The input lists recorded by the last bundle run, keyed by bundle filename. */
export function readInputs(cliRoot) {
  try {
    return JSON.parse(readFileSync(join(cliRoot, INPUTS_PATH), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Record one bundle's input list, leaving the other bundle's entry alone.
 *
 * `npm run bundle` runs the two bundlers as separate processes, so this is a
 * read-modify-write rather than a truncate — otherwise whichever ran second
 * would erase the first one's answer and the test would silently check half of
 * what it thinks it checks.
 */
export function writeInputs(cliRoot, bundleFile, sources) {
  const all = readInputs(cliRoot);
  all[bundleFile] = sources;
  const ordered = Object.fromEntries(Object.keys(all).sort().map((k) => [k, all[k]]));
  writeFileSync(join(cliRoot, INPUTS_PATH), JSON.stringify(ordered, null, 2) + "\n");
}

/** The stamp a built bundle carries, or null for one built before stamps existed. */
export function stampOf(bundlePath) {
  const first = readFileSync(bundlePath, "utf8").split("\n", 1)[0];
  return first.startsWith(STAMP_PREFIX) ? first.slice(STAMP_PREFIX.length).trim() : null;
}

/**
 * Put the stamp on a bundle that is already written.
 *
 * `--banner:js` cannot be used any more: the stamp is computed from esbuild's
 * metafile, which does not exist until esbuild has run. Prepending afterwards is
 * safe because neither bundler emits a source map, so nothing holds a line
 * offset into this file.
 */
export function prependStamp(bundlePath, stamp) {
  writeFileSync(bundlePath, `${STAMP_PREFIX}${stamp}\n` + readFileSync(bundlePath, "utf8"));
}
