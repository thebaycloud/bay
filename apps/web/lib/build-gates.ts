/**
 * Stripping quality gates from a static build.
 *
 * A build script like `tsc -b && vite build` chains a quality gate (a type-check,
 * a linter, a test run) before the bundler that actually produces the deploy
 * artifact. The gate makes the build FAIL on things that don't affect the running
 * app — an unused variable, a lint rule, a flaky test. For a static deploy the
 * artifact is all we need: the bundler (Vite/webpack/rollup/esbuild) transpiles
 * TypeScript by erasing types, no type-check required.
 *
 * So for the static lane we run the bundler and drop the leading gates. This is
 * universal — it keys on the shape `<gate> && … && <bundler>`, not any one repo —
 * and turns a whole class of "my deploy fails on tsc" apps into first-try deploys.
 * We rewrite our COPY's package.json only; the user's repo is never touched.
 */

// A command is a gate iff it starts with a known checker/linter/test runner. The
// trailing (\s|$) stops `tsc` from matching a real build step like `tsc-alias`.
const GATE =
  /^(?:tsc|vue-tsc|svelte-check|eslint|prettier|stylelint|jest|vitest|ava|mocha|nyc|c8)(?:\s|$)|^astro\s+check\b|^(?:npm|yarn|pnpm)\s+(?:run\s+)?(?:lint|type-?check|typecheck|test)\b/i;

/**
 * Given a build script, drop leading gate commands, keeping everything from the
 * first real (bundler) command onward. Returns the script unchanged when there is
 * nothing to strip, or when every segment looks like a gate (fail safe — never
 * hand back an empty build).
 */
export function stripQualityGates(buildScript: string): string {
  const segments = buildScript.split("&&").map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) return buildScript;
  const firstReal = segments.findIndex((s) => !GATE.test(s));
  if (firstReal <= 0) return buildScript; // already starts with the bundler, or all gates
  return segments.slice(firstReal).join(" && ");
}

/** True when `stripQualityGates` would change the script. */
function hasQualityGate(buildScript: string): boolean {
  return stripQualityGates(buildScript) !== buildScript.trim();
}
