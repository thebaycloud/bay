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
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const STAMP_PREFIX = "// supersonic-vendor-stamp ";

/** apps/web/lib is reachable from the CLI only as a build input; see src/resolver.entry.ts. */
export const BUNDLES = {
  "resolve.js": [
    "packages/cli/src/resolver.entry.ts",
    "apps/web/lib/resolve.ts",
    "apps/web/lib/app-config.ts",
    "apps/web/lib/infer-services.ts",
    "apps/web/lib/repo-facts.ts",
    "apps/web/lib/lanes.ts",
    "apps/web/lib/plan-deps.ts",
  ],
  "detector.js": [
    "services/deploy-agent/src/index.ts",
    "apps/web/lib/plan-deps.ts",
  ],
};

/** One hash over every input, so an edit to any of them invalidates the bundle. */
export function stampSources(repoRoot, sources) {
  const h = createHash("sha256");
  for (const rel of sources) h.update(rel).update("\0").update(readFileSync(join(repoRoot, rel)));
  return h.digest("hex").slice(0, 16);
}

/** The stamp a built bundle carries, or null for one built before stamps existed. */
export function stampOf(bundlePath) {
  const first = readFileSync(bundlePath, "utf8").split("\n", 1)[0];
  return first.startsWith(STAMP_PREFIX) ? first.slice(STAMP_PREFIX.length).trim() : null;
}
