import { createHash } from "node:crypto";
import { ASSETS_BUCKET } from "./static-release";
import { buildTagsBlock, BUILD_TIMEOUT } from "./build-config";
import { resilientInstall } from "./install";

/**
 * The Cloud Build config for the static lane, and the node_modules cache that
 * rides along with it.
 *
 * This lives in lib/ rather than in app/api/deploy/route.ts for two reasons. The
 * hard one: a Next.js route file may only export request handlers and route
 * config, so a helper exported from one fails the production build with
 * `"staticBuildConfig" is not a valid Route export field`. The useful one: this
 * is pure string building with a shell and a YAML escaping layer stacked on top
 * of each other, and the only way to know it is right is to assert on the exact
 * bytes it emits. See test/static-build.test.ts.
 *
 * ── The escaping rule ────────────────────────────────────────────────────────
 * Cloud Build expands `$FOO` and `$(...)` as its own substitutions on the YAML
 * *before* the step runs, so a bare `$L` fails validation ("key L is not a valid
 * built-in substitution") and a bare `$BUILD_ID` silently expands into something
 * the shell never wrote. `$$` is the literal-dollar escape.
 *
 * Rather than hand-doubling each `$` at the point it is typed — which is how the
 * last break shipped, and which cannot cover a `$` that arrives inside an
 * interpolated value such as the repo's own outputDir — every script here is
 * written in plain shell with single `$`, and `escapeForCloudBuild` doubles them
 * all in one pass as the last transform before the string reaches the YAML.
 * One rule, applied once, in a place a test can see.
 */

/** Where the restore step drops the tarball it downloaded. */
const TARBALL = "/workspace/.deps.tgz";
/**
 * Written only after a tarball extracted cleanly. Every later decision keys off
 * this, not off the tarball's presence: a truncated download leaves a file on
 * disk, and treating that as a cache hit is what makes a corrupt entry poison a
 * project's deploys forever with no way to self-heal.
 */
const MARKER = "/workspace/.deps-restored";
/**
 * The cache object's name, decided by the restore step and read back by the save
 * step.
 *
 * Not recomputed at save time, and that is the point. `npm ci` fails whenever
 * package.json and package-lock.json disagree — the case lib/install.ts exists
 * for — and the `|| npm install` fallback then **rewrites the lockfile**. Its
 * hash after the build is therefore a different hash from the one the restore
 * looked up, so the tarball was stored under a key no restore would ever ask
 * for: those projects paid tar + upload on every single build and could never
 * get a hit. Freezing the key before the build runs is what makes the write and
 * the read address the same object.
 */
const KEYFILE = "/workspace/.deps-key";
/**
 * Written when this build must neither read nor write the cache. Today that is
 * one case — a repo that vendors its own node_modules — and it needs a marker
 * because the restore step is the only step that can tell a *committed* tree
 * from one the install produced. Without it the save step saw a node_modules,
 * could not know where it came from, and published the repo's vendored tree as
 * the shared cache entry for every project of that tenant with the same
 * lockfile: one repo's committed dependencies landing in another repo's build.
 */
const SKIP = "/workspace/.deps-skip";

/**
 * The lockfiles we know how to key on, most authoritative first for the package
 * manager actually being used.
 *
 * Order matters and `ls` cannot express it: `ls a b c` sorts its output no
 * matter what order the arguments are in, so picking `ls <lockfiles> | head -1`
 * always chose package-lock.json when several were present. A yarn project that
 * still carries a stale package-lock.json — extremely common, npm writes one the
 * first time anybody runs `npm install` by accident — therefore keyed on a file
 * yarn never updates: a real dependency change moved yarn.lock, the key did not
 * move, and a stale tree was restored. The install command says which manager is
 * in charge, so it decides.
 */
export function lockfilePreference(installCommand: string | null): string[] {
  const cmd = (installCommand ?? "").trim();
  if (/^yarn\b/.test(cmd)) return ["yarn.lock", "pnpm-lock.yaml", "package-lock.json"];
  if (/^pnpm\b/.test(cmd)) return ["pnpm-lock.yaml", "yarn.lock", "package-lock.json"];
  return ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"];
}

/**
 * Shell that sets `L` to the first lockfile present, in preference order.
 *
 * A `for` loop rather than `ls … | head -1` precisely because `ls` sorts.
 */
function pickLockfile(order: string[]): string {
  return `L=""; for f in ${order.join(" ")}; do [ -f "$f" ] && { L="$f"; break; }; done`;
}

/**
 * Doubles every `$` so Cloud Build passes it through to the shell verbatim.
 *
 * Applied to a whole step script exactly once. `$$$$` in the replacement is two
 * literal dollars: `$$` is the escape for a `$` in `String.replace`.
 */
export function escapeForCloudBuild(script: string): string {
  return script.replace(/\$/g, "$$$$");
}

/**
 * A shell word that means exactly the string given, whatever is in it.
 *
 * Single quotes suspend everything the shell would otherwise do — expansion,
 * word splitting, globbing — and the only character they cannot contain is a
 * single quote, which is closed, escaped and reopened. Values that come out of
 * the user's repository (outputDir is `s.serve.outputDir`, read by the detector)
 * go through here; the previous version interpolated them raw, so a directory
 * named `dist out` word-split the rsync into the wrong arguments and one
 * containing `$` reached Cloud Build unescaped.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * What makes two node_modules trees interchangeable.
 *
 * The lockfile hash alone does not: an identical lockfile installed by `npm ci`
 * and by `npm install --omit=dev` produces different trees, and native modules
 * (esbuild, sharp, @swc/core) are compiled against the base image's platform and
 * ABI — restore a tree built on a different image and the install "succeeds"
 * while the build fails on something that looks unrelated. All of it belongs in
 * the key.
 *
 * `namespace` is the tenant. A tarball is not the dependency graph, it is
 * node_modules as it stood after some *particular* project's install, including
 * whatever that project's postinstall scripts wrote into it (generated Prisma
 * clients, patch-package output, .bin shims). Sharing that across tenants means
 * one customer's postinstall output landing in another customer's build tree,
 * under our service account. Cross-tenant reuse is a decision to take
 * deliberately, not a side effect of a hash that was too short.
 */
export function depsCacheScope(opts: {
  builder: string;
  installCommand: string | null;
  namespace: string;
}): string {
  // NUL is the field separator, so no value can impersonate a boundary. It is
  // written as the escape rather than as a raw 0x00 byte: a raw one made this
  // whole file `data` to git, which reported it as `Bin 0 -> 11905 bytes` and
  // hid every line from `git diff` — and so from any diff-based review of the
  // file that generates every static build. Same character, same keys.
  return createHash("sha256")
    .update([opts.namespace, opts.builder, opts.installCommand ?? ""].join("\u0000"))
    .digest("hex")
    .slice(0, 32);
}

/**
 * The install to run when the cache already put node_modules on disk.
 *
 * `npm ci` deletes node_modules wholesale before it installs — verified, not
 * assumed — so on the npm path a restore was a 30-130MB download that was thrown
 * away microseconds later and then paid for in full by the install anyway.
 * Strictly worse than no cache.
 *
 * The fix is not to skip the install (a stale or subtly wrong tarball would then
 * fail the build with no way back) and not to skip the cache (npm is the default
 * path, so that gives up the feature for almost everyone). It is to install
 * incrementally: `npm install` reconciles the tree it finds against the
 * lockfile, which is close to free when they already agree and self-heals when
 * they do not.
 *
 * yarn and pnpm do not wipe node_modules and are already incremental, so their
 * command is left exactly as the detector produced it.
 */
export function warmInstall(installCommand: string): string {
  if (!/^npm ci\b/.test(installCommand)) return installCommand;
  return `npm install ${installCommand.replace(/^npm ci\s*/, "")}`.trimEnd();
}

/**
 * The install half of the build step: incremental on a cache hit, reproducible
 * (with npm's fallback, see lib/install.ts) on a miss.
 */
export function installScript(installCommand: string | null): string | null {
  const cold = resilientInstall(installCommand);
  if (!cold || !installCommand) return null;
  const warm = warmInstall(installCommand);
  if (warm === cold) return cold;
  return `if [ -f ${MARKER} ]; then ${warm}; else ${cold}; fi`;
}

/**
 * Where a project's cached node_modules lives. `_deps/v2` because v1 was keyed
 * wrong.
 *
 * `$K` is `<lockfile name>-<lockfile hash>`, computed once in the restore step
 * and read back from KEYFILE by the save step. Carrying the lockfile's own name
 * means a repo with several lockfiles cannot key one manager's tree under
 * another's name; carrying a hash frozen before the build means the save cannot
 * address a different object than the restore did.
 */
function tarballUrl(bucket: string, scope: string): string {
  return `"gs://${bucket}/_deps/v2/${scope}/$K.tgz"`;
}

/**
 * Step 1: try to put node_modules back before anything runs.
 *
 * Every failure here is swallowed. A cache miss, an unreadable object, a
 * truncated tarball: none of them may fail a build. A caching layer that can
 * fail a build is worse than no caching layer.
 *
 * `exit 0` is safe in this step and only in this step, because this step does
 * nothing else. That is the whole reason the save and the publish are no longer
 * in one script with it.
 */
export function depsRestoreScript(bucket: string, scope: string, installCommand: string | null = null): string {
  return [
    pickLockfile(lockfilePreference(installCommand)),
    `[ -n "$L" ] || exit 0`,
    // A repo that vendors its own node_modules gets to keep it. Extracting over
    // the top would merge, not replace, leaving stale packages from the cache
    // alongside the committed ones. The marker is what tells the save step this
    // tree is the repo's and not ours to publish.
    `[ -d node_modules ] && { echo "node_modules is committed - skipping the dependency cache"; : > ${SKIP}; exit 0; }`,
    `H=$(sha256sum "$L" | cut -c1-64)`,
    `K="$L-$H"`,
    // Frozen here, before anything can rewrite the lockfile under us.
    `printf '%s' "$K" > ${KEYFILE}`,
    `echo "deps cache key $H"`,
    `gcloud storage cp ${tarballUrl(bucket, scope)} ${TARBALL} 2>/dev/null || exit 0`,
    `tar -xzf ${TARBALL} -C /workspace 2>/dev/null && : > ${MARKER} && echo "deps restored from cache" || { rm -f ${TARBALL}; echo "deps cache entry unusable - ignoring it"; }`,
  ].join("; ");
}

/**
 * Step 3: keep the tree this build produced, if it is not already up there.
 *
 * The skip is keyed on the restore marker, so the one case that must overwrite —
 * an entry that downloaded but would not extract — does overwrite.
 */
export function depsSaveScript(bucket: string, scope: string): string {
  return [
    // The repo's own vendored node_modules is not ours to publish to a cache
    // every sibling project of this tenant reads back.
    `[ -f ${SKIP} ] && exit 0`,
    `[ -f ${MARKER} ] && exit 0`,
    // The key the restore step looked up, not one recomputed from a lockfile the
    // install may have rewritten in the meantime.
    `K=$(cat ${KEYFILE} 2>/dev/null)`,
    `[ -n "$K" ] || exit 0`,
    `[ -d node_modules ] || exit 0`,
    `tar -czf /tmp/deps.tgz node_modules 2>/dev/null || exit 0`,
    `gcloud storage cp /tmp/deps.tgz ${tarballUrl(bucket, scope)} 2>/dev/null && echo "deps cached" || true`,
  ].join("; ");
}

/**
 * Written immediately before the build runs, so "what did this build produce"
 * is answerable afterwards.
 *
 * Nothing else can answer it. See `publishScript`: the output directory was
 * predicted from the framework's name, and a framework's name does not decide
 * where it writes — its config does, and every one of them is overridable.
 */
const BUILD_START = "/workspace/.ss-build-start";

/** The build's own scratch files, all of them under /workspace. */
/** Where the resolve step records the directory the publish step must upload. */
const OUTDIR = "/workspace/.ss-outdir";

const SCRATCH = [TARBALL, MARKER, KEYFILE, SKIP, BUILD_START, OUTDIR];

/**
 * Step 4: the assets go to GCS.
 *
 * This is its own step, and **nothing here may be able to `exit`**. That is a
 * correctness requirement rather than tidiness: the rsync used to be appended to
 * the save script with a `;`, and the save script is a chain of `exit 0` guards.
 * `exit` ends the shell, so every guard that fired (cache hit, no lockfile, no
 * node_modules) took the upload with it. The step still exited 0, Cloud Build
 * reported SUCCESS, the deploy published nothing, and the pointer moved to a
 * release that did not exist. The cache working was precisely what broke the
 * deploy.
 *
 * The `rm -f` obeys that rule — it cannot exit the shell and cannot fail — and
 * it is here because the cache's scratch files live in `/workspace`, which is
 * also a legal `outputDir`: `s.serve.outputDir` defaults to `"."`, and this step
 * now runs unconditionally, so a cache-hit build with that outputDir would rsync
 * `.deps.tgz` — a 30-130MB dependency tarball — and the markers into a
 * world-readable release prefix. Before the publish was made unconditional the
 * tarball's presence was exactly what suppressed the upload, so this could not
 * happen; now it can, and deleting them is cheaper than reasoning about which
 * detector outputs are reachable.
 *
 * (What this does NOT cover: `node_modules` itself, still in `/workspace` on a
 * cache-hit build with outputDir `.`. Removing it before the upload would break
 * nothing today but is not this step's business, and no detector path currently
 * emits outputDir `.` together with a build command — packages/detector's
 * `staticSite()` returns `.` only with a null install and build command, which
 * routes around Cloud Build entirely.)
 */
export function resolveOutputScript(outputDir: string): string {
  const declared = shellQuote(outputDir);
  return [
    // The declared directory first. It is what the repo or the user said, it is
    // right for every deploy that works today, and preferring it means this can
    // only add deploys that currently fail — never change one that works.
    `D=${declared}`,
    // Discovery, and only when the prediction turned out to be wrong.
    //
    // WHY THIS EXISTS. The directory used to be predicted from a framework's
    // name — vite→dist, react-scripts→build, astro→dist, sveltekit→build,
    // next-export→out. That is a proper noun SUPPLYING a value the repository
    // already answers, which is the one thing docs/MAKE-DEPLOYS-WORK.md's first
    // rule forbids, and it is wrong in two directions at once. Every one of
    // those defaults is overridable in the project's own config
    // (`build.outDir`, `outDir`, `distDir`, `BUILD_PATH`, adapter `pages`), and
    // the list of tools that has one is unbounded — Angular, Gatsby, Eleventy,
    // Hugo, Docusaurus, VitePress, Parcel, and whatever ships next month. A
    // longer table is the same defect with more rows.
    //
    // The build has already run, in this same /workspace, so the answer is on
    // disk: the directory holding an index.html that did not exist before the
    // build started. `-newer` against the marker is what makes that precise —
    // a repo's SOURCE index.html (Vite keeps one at the root) is older than the
    // marker and cannot be mistaken for output. Shallowest wins, so `dist/`
    // beats `dist/nested/`.
    // One element, not several joined by `; ` — `then; F=""` is a bash syntax
    // error, and the whole script is a single shell line.
    // POSIX `find`, deliberately: `-printf` is a GNU extension. The build image
    // is Debian so it would have worked, but it fails silently on a BSD `find`
    // — which is what a developer running this locally has, so the one construct
    // nobody could test was the one doing the choosing. `awk -F/ {print NF}`
    // counts path segments instead, which is the same shallowest-wins ordering
    // and runs anywhere.
    `if [ ! -d "$D" ] || [ -z "$(ls -A "$D" 2>/dev/null)" ]; then`
      + ` F=""; [ -f ${BUILD_START} ] && F=$(find . -name index.html -newer ${BUILD_START}`
      + ` -not -path './node_modules/*' -not -path './.git/*' 2>/dev/null`
      + ` | awk -F/ '{print NF" "$0}' | sort -n | head -1 | cut -d' ' -f2-);`
      + ` if [ -n "$F" ]; then D=$(dirname "$F");`
      + ` echo "the build wrote $D, not the predicted directory - publishing what it produced"; fi;`
      + ` fi`,
    // A diagnostic, NOT a guard — deliberately no `exit`.
    //
    // Nothing that can end this shell may share it with the upload: that is the
    // outage recorded below, where the cache's `exit 0` chain took the rsync with
    // it and Cloud Build still reported SUCCESS. A missing directory needs no
    // guard anyway, because the rsync itself fails on one — "Did not find
    // existing container at: <dir>" is exactly the error this line explains.
    `if [ ! -d "$D" ]; then echo "no build output: $D does not exist and the build wrote no index.html"; fi`,
    // The answer, handed to the next step through /workspace. Deliberately a
    // separate step from the upload: every conditional above is one more thing
    // that could stand between the pipeline and the rsync, and the rule the
    // upload step enforces is that NOTHING may. See `publishScript`.
    `printf '%s' "$D" > ${OUTDIR}`,
  ].join("; ");
}

/**
 * Step 5: the assets go to GCS.
 *
 * **Nothing here may be able to `exit`, and no conditional may stand between
 * this step and the upload.** That is a correctness requirement rather than
 * tidiness, and it is why the directory is resolved in its own step above: the
 * rsync used to be appended to the save script with a `;`, and the save script
 * is a chain of `exit 0` guards. `exit` ends the shell, so every guard that
 * fired (cache hit, no lockfile, no node_modules) took the upload with it. The
 * step still exited 0, Cloud Build reported SUCCESS, the deploy published
 * nothing, and the pointer moved to a release that did not exist. The cache
 * working was precisely what broke the deploy.
 *
 * So this step is three commands that cannot branch: read the directory the
 * previous step chose, clear the scratch, upload. If `.ss-outdir` is missing the
 * substitution is empty and the rsync fails loudly, which is the correct outcome
 * and not a silent skip.
 *
 * The `rm -f` obeys the same rule — it cannot exit and cannot fail — and it is
 * here because the cache's scratch files live in `/workspace`, which is also a
 * legal `outputDir`: a cache-hit build with outputDir `.` would otherwise rsync
 * `.deps.tgz`, a 30-130MB dependency tarball, into a world-readable release
 * prefix. `$D` is captured BEFORE the `rm`, because `.ss-outdir` is scratch too.
 */
export function publishScript(destination: string): string {
  return `D=$(cat ${OUTDIR} 2>/dev/null); rm -f ${SCRATCH.join(" ")}; `
    + `gcloud storage rsync -r "$D" ${shellQuote(destination)}`;
}

function step(image: string, script: string): string[] {
  return [
    `  - name: ${image}`,
    "    entrypoint: bash",
    // JSON-quoted args rather than a `|` block scalar: a block scalar would
    // reintroduce indentation bugs and would not save any escaping.
    `    args: ["-lc", ${JSON.stringify(escapeForCloudBuild(script))}]`,
  ];
}

/**
 * Cloud Build config for the static lane: restore deps, install and build, save
 * deps, copy the output straight to GCS. The bytes never travel back through the
 * control plane.
 */
export function staticBuildConfig(opts: {
  installCommand: string | null;
  buildCommand: string | null;
  outputDir: string;
  destination: string;
  /** The tenant the cache entry belongs to — a workspace id, or the owner's id. */
  namespace: string;
  /** Tags the build so its log can be found again by app rather than by recency. */
  slug?: string;
  /** Overridable so a test can pin the config without depending on the environment. */
  builder?: string;
  bucket?: string;
}): string {
  // The whole point of the warm base is the package cache it carries, and the
  // static lane is where dependency installation dominates: measured on a real
  // Vite deploy, 77s of an 83s deploy was this step. Pulling node:22-slim from
  // Docker Hub instead threw that away.
  // `||`, not `??`. These are Cloud Run environment variables, where "set but
  // empty" is a perfectly ordinary state — and `??` falls through only on
  // null/undefined, so `NEXT_BASE_IMAGE=""` selected the empty string and the
  // config went out with `  - name: ` for a step image, which Cloud Build
  // rejects at submit. The code this replaced used `||`, and route.ts:275 and
  // :310 still do. Same operator, or the same outage.
  const builder = opts.builder || process.env.NEXT_BASE_IMAGE || process.env.NODE_BASE_IMAGE || "node:22-slim";
  const bucket = opts.bucket ?? ASSETS_BUCKET;
  const CLOUD_SDK = "gcr.io/google.com/cloudsdktool/google-cloud-cli:slim";
  const scope = depsCacheScope({ builder, installCommand: opts.installCommand, namespace: opts.namespace });

  // Cloud Build shares /workspace between steps and every step here defaults its
  // dir to /workspace, so node_modules restored in step 1 is the same directory
  // the build in step 2 sees.
  // The marker is stamped before install and build, so everything either of them
  // writes is newer than it. That is what lets the publish step below ask the
  // filesystem where the output went instead of predicting it from a framework
  // name. `touch` cannot fail in a way worth guarding, and it is separated by
  // `;` rather than `&&` so it can never gate the build.
  const build = `touch ${BUILD_START}; `
    + ([installScript(opts.installCommand), opts.buildCommand].filter(Boolean).join(" && ") || "true");

  return [
    "steps:",
    ...step(CLOUD_SDK, depsRestoreScript(bucket, scope, opts.installCommand)),
    ...step(builder, build),
    ...step(CLOUD_SDK, depsSaveScript(bucket, scope)),
    // Its own step, so the upload's shell stays free of conditionals.
    ...step(CLOUD_SDK, resolveOutputScript(opts.outputDir)),
    ...step(CLOUD_SDK, publishScript(opts.destination)),
    "options:",
    // No machineType on purpose: across the last 20 builds in this project every
    // E2_HIGHCPU_8 build queued 44-57s before starting and every default-pool
    // build queued 1s, which is more than the bigger machine ever gave back.
    "  logging: CLOUD_LOGGING_ONLY",
    ...buildTagsBlock(opts.slug),
    ...BUILD_TIMEOUT,
    "",
  ].join("\n");
}
