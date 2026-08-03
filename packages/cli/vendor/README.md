Generated. Do not edit — `npm run bundle` rebuilds all of it.

- detector.js — scripts/bundle-detector.mjs, from services/deploy-agent
- resolve.js  — scripts/bundle-resolver.mjs, from apps/web/lib
- inputs.json — every repository file esbuild inlined into each bundle, from its metafile.
                test/vendor.test.js hashes these to prove the bundles are not stale.
