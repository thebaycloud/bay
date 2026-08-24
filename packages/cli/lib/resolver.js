"use strict";
/**
 * The one door between the CLI and the control plane's resolution logic.
 *
 * `vendor/resolve.js` is apps/web/lib/{resolve,app-config,infer-services,
 * repo-facts,lanes,plan-deps}.ts compiled by scripts/bundle-resolver.mjs — the
 * same source the server runs, not a port of it. Everything in this package that
 * needs to know what a repository deploys to goes through here, so there is
 * exactly one answer to that question in the repository and no way for a second
 * one to appear without deleting this file.
 *
 * Loaded lazily and through a named function rather than at require() time: the
 * bundle is generated, an old global install can be missing it, and a missing
 * bundle must fail `bay check` with a sentence naming the fix rather than
 * crashing `bay logs`, which does not use it at all.
 */
const path = require("node:path");

let cached = null;

/** The bundled resolver, or a thrown error saying how to build it. */
function resolver() {
  if (cached) return cached;
  try {
    cached = require("../vendor/resolve.js");
  } catch (e) {
    throw new Error(
      "this build of the CLI has no bundled resolver (vendor/resolve.js).\n" +
      "  From a checkout: npm run bundle -w supersonic-cli\n" +
      `  Underlying error: ${e && e.message ? e.message : String(e)}`,
    );
  }
  return cached;
}

/**
 * The stack detector, as the async `Detect` that inferAppConfig expects.
 *
 * Synchronous in the CLI — there is one process, one repo, and nothing else
 * waiting on the event loop. The control plane spawns the detector as a
 * subprocess for the same job, which is why the interface is a promise at all;
 * matching the interface rather than the transport is what lets both callers
 * share inferAppConfig unchanged.
 */
function detector() {
  const { detectStack } = require("../vendor/detector.js");
  return async (absoluteDir) => detectStack(absoluteDir);
}

/**
 * Resolve a directory the way a deploy will, with inference as the fallback.
 *
 * The detector is passed in every time. resolve() without one throws on a repo
 * that has no supersonic.json — correct for the server, which must not guess
 * silently, and useless for a CLI whose entire job here is to show the user what
 * the guess would be before it costs eleven minutes.
 */
async function resolveHere(dir) {
  const r = resolver();
  return r.resolve(dir, detector());
}

module.exports = { resolver, detector, resolveHere, BUNDLE: path.join(__dirname, "..", "vendor", "resolve.js") };
