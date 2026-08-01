/**
 * Everything `supersonic init` and `supersonic check` need from the control
 * plane, gathered into one bundle input.
 *
 * This file contains no logic on purpose. It is a MANIFEST: esbuild follows these
 * imports and inlines apps/web/lib/{resolve,app-config,infer-services,repo-facts,
 * lanes,plan-deps}.ts into vendor/resolve.js, so the CLI and the server run the
 * same bytes of the same source. The alternative the plan warns about — porting
 * the resolver to JavaScript beside the TypeScript one — would put two answers to
 * "what does this repo deploy to" in the repository, and the failure mode is the
 * worst kind: `supersonic check` passes locally, the deploy resolves differently
 * on the server, and both look right on their own. That is the exact bug the
 * single-resolution-path work exists to kill, so it must not be reintroduced by
 * the tool built to make it visible.
 *
 * Why a bundle rather than a move: apps/web imports every one of these today, and
 * resolve.ts is the control plane's own entry into them. Moving them into
 * packages/cli would break Next's bundling of lib/ (see the RUNTIME_VERSIONS
 * comment in plan-deps.ts — the control-plane image copies apps/web and
 * services/deploy-agent and nothing else). Bundling costs one generated file and
 * breaks nothing.
 *
 * Precedent: vendor/detector.js already does this for the stack detector, for the
 * same reason, wired to the same prepublishOnly.
 */

export {
  resolve, validate, assertConsumed, deriveLane, missingSecrets,
  ResolveError, ConfigError,
} from "../../../apps/web/lib/resolve";

export {
  CONFIG_FILENAME, readAppConfig, parseAppConfig, platformOwned,
  primaryService, servicePath, appResources,
} from "../../../apps/web/lib/app-config";

export {
  inferAppConfig, deployableParts, serviceFor, isDeployablePart,
  bindToPort, pythonInstall, pythonModule,
} from "../../../apps/web/lib/infer-services";

export { readRepoFacts, declaredLanguages, normalizeLanguage } from "../../../apps/web/lib/repo-facts";

// The manifest half of plan-deps: what the runner images actually provide, and
// the sentence to say when a repo asks for more. `check` is the first thing that
// can say it before a build starts paying for it.
export { RUNTIME_VERSIONS, runtimeMismatch, RUNTIME_UNSUPPORTED } from "../../../apps/web/lib/plan-deps";

export { DEFAULT_SCALE } from "../../../apps/web/lib/lanes";
