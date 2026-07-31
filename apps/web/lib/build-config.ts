/**
 * Cloud Build configs for the container lanes, and the filter that decides which
 * of a build's output lines a customer sees.
 *
 * This lives in lib/ rather than in app/api/deploy/route.ts because a Next.js
 * route file may only export request handlers and route config — exporting a
 * helper from one fails the production build with
 * `"cachedBuildConfig" is not a valid Route export field`.
 */

/** Which image builder the container lanes use. */
export type Builder = "kaniko" | "buildkit";

/**
 * Kaniko was archived by Google on 2025-06-03, and buildx/BuildKit caches
 * strictly more than it did. The switch is behind an env var so it can be rolled
 * out and reverted without a code change, and it defaults to the behaviour that
 * is in production today.
 *
 *   BUILDER=buildkit  → buildx/BuildKit with a registry cache in mode=max
 *   anything else     → Kaniko (default)
 */
export function selectedBuilder(env: Record<string, string | undefined> = process.env): Builder {
  return env.BUILDER === "buildkit" ? "buildkit" : "kaniko";
}

/**
 * The Cloud Build tag marking which app a build belongs to.
 *
 * Cloud Build offers no other way to ask "which build was this app's?" after the
 * fact, and the answer matters: a failed build's log is the evidence the repair
 * agent debugs from, so picking the wrong build sends it editing a customer's
 * code over a stranger's error. Tags must match [\w][\w.-]{0,127} and slugs are
 * lowercase alphanumeric, so the prefix is both a namespace and the guarantee
 * that a slug can never collide with some other tag in the project.
 */
export function appBuildTag(slug: string): string {
  return `supersonic-app-${slug}`;
}

/** The `tags:` block for a generated config. Omitted entirely when no slug is known. */
export function buildTagsBlock(slug?: string): string[] {
  return slug ? ["tags:", `  - ${appBuildTag(slug)}`] : [];
}

/**
 * The Cloud Build id in one line of gcloud output, if there is one.
 *
 * Both `builds submit` and `run deploy --source` announce the build they just
 * started by printing its log URL, and the id sits in the path. That line is the
 * only moment a deploy learns which build is *its own* — everything after it
 * (the log, the failure, the evidence handed to the repair agent) depends on
 * having caught it, so this is pinned by test rather than left to a regex nobody
 * re-reads.
 *
 * The `builds` guard is what keeps it honest: build ids are bare UUIDs, and a
 * deploy's output is full of other UUIDs (revision suffixes, operation names,
 * request ids). Only a line that is talking about builds is allowed to answer.
 */
const CLOUD_BUILD_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;
export function cloudBuildIdFrom(line: string): string | null {
  if (!line.includes("builds")) return null;
  return line.match(CLOUD_BUILD_ID)?.[0] ?? null;
}

/**
 * Kaniko build with registry layer caching. Caches each layer (crucially the
 * `npm install` layer) keyed on the files it depends on, so an unchanged
 * package.json means deps are pulled from cache instead of rebuilt.
 *
 * Kept as the default and as the revert path for BUILDER=buildkit.
 */
export function kanikoBuildConfig(image: string, slug?: string): string {
  return [
    "steps:",
    "  - name: gcr.io/kaniko-project/executor:latest",
    "    args:",
    `      - --destination=${image}:latest`,
    "      - --dockerfile=Dockerfile",
    "      - --cache=true",
    "      - --cache-ttl=168h",
    `      - --cache-repo=${image}-cache`,
    "      - --snapshot-mode=redo",
    "      - --use-new-run",
    "options:",
    // No machineType on purpose. Asking for a non-default machine makes Cloud
    // Build provision a dedicated worker, and that wait is not small: across the
    // last 20 builds in this project the split is perfect — every E2_HIGHCPU_8
    // build queued 44-57s before starting, every default-pool build queued 1s.
    // Our app builds finish in 38-72s, so paying ~50s of provisioning to shave a
    // few seconds off an already-short build was a net loss of roughly a minute
    // on every deploy. If app builds ever grow into the multi-minute range,
    // measure again — at that size the bigger machine can start paying for itself.
    "  logging: CLOUD_LOGGING_ONLY",
    ...buildTagsBlock(slug),
    "",
  ].join("\n");
}

/**
 * buildx/BuildKit build with a registry layer cache in `mode=max`.
 *
 * `mode=max` is not an optimisation, it is the whole point. BuildKit's default
 * is `mode=min`, which exports only the layers present in the FINAL image. Our
 * generated Dockerfiles are multi-stage, so `npm install` lives in the `build`
 * stage and never lands in the final image — under `mode=min` it is thrown away
 * and every source-only redeploy reinstalls every dependency. `mode=max` exports
 * the intermediate layers too, which is what Kaniko's `--cache=true` did.
 *
 * Cloud Build has no BuildKit daemon and buildx's default `docker` driver cannot
 * export a registry cache at all ("cache export feature is currently not
 * supported for docker driver"), so a `docker-container` builder is created
 * first. `gcr.io/cloud-builders/docker` has /var/run/docker.sock, which is what
 * that driver needs to spawn its buildkit container.
 *
 * The leading `docker buildx version` is a guard: if the buildx plugin is
 * missing from the builder image, the step dies on line 1 with a legible message
 * instead of somewhere confusing.
 *
 * Attestations are suppressed with BUILDX_NO_DEFAULT_ATTESTATIONS rather than
 * `--provenance=false`, because an unknown *flag* is a hard failure on older
 * buildx (`unknown flag: --provenance`, exit 125) while an unknown env var is
 * silently ignored.
 *
 * Cache absence never fails a deploy:
 *   - `--cache-from` on a ref that does not exist logs an ERROR and continues
 *     (exit 0), so the first build for an app self-heals and the cache repo does
 *     not have to be pre-created.
 *   - `--cache-to` that cannot reach its registry DOES fail the build, so
 *     `ignore-error=true` is mandatory. Without it a missing
 *     artifactregistry.writer grant, an AR outage, or a deleted repo turns every
 *     customer deploy into a failure that then gets handed to the repair agent.
 *     Same principle already written into staticBuildConfig: a caching layer
 *     that can fail a build is worse than no caching layer.
 */
/**
 * The BuildKit daemon image the `docker-container` driver runs.
 *
 * Unset by default, which means buildx's own `moby/buildkit:buildx-stable-1` —
 * a **Docker Hub** pull on the critical path of every container build. That is
 * the exact dependency this project already removed once (see the NODE_BASE
 * comment in app/api/deploy/route.ts: "removes a Docker Hub pull — and its rate
 * limit — from every build"), and Cloud Build workers share egress IPs, so an
 * anonymous pull limit is a hard deploy failure rather than a slow build. The
 * env var is the lever to point it at an Artifact Registry mirror once one
 * exists; it stays unset until then so a mirror that cannot be pulled cannot
 * take deploys down either.
 *
 * The charset guard is not paranoia: this string lands inside a `bash -c`
 * argument in a Cloud Build YAML, where a `$` fails validation outright.
 */
const SAFE_IMAGE_REF = /^[A-Za-z0-9._:/@-]+$/;

export function buildkitImage(env: Record<string, string | undefined> = process.env): string | null {
  const ref = (env.BUILDKIT_IMAGE ?? "").trim();
  return ref && SAFE_IMAGE_REF.test(ref) ? ref : null;
}

export function buildkitBuildConfig(image: string, daemonImage: string | null = buildkitImage(), slug?: string): string {
  const cache = `${image}-cache:cache`;
  const script = [
    "docker buildx version",
    ["docker buildx create --use --driver docker-container", ...(daemonImage ? [`--driver-opt image=${daemonImage}`] : [])].join(" "),
    [
      "docker buildx build",
      "-f Dockerfile",
      `--cache-from type=registry,ref=${cache}`,
      `--cache-to type=registry,ref=${cache},mode=max,ignore-error=true`,
      `-t ${image}:latest`,
      "--push",
      ".",
    ].join(" "),
  ].join(" && ");

  return [
    "steps:",
    "  - name: gcr.io/cloud-builders/docker",
    "    entrypoint: bash",
    '    env: ["DOCKER_BUILDKIT=1", "BUILDX_NO_DEFAULT_ATTESTATIONS=1"]',
    // JSON-quoted args, the same style staticBuildConfig uses. A `|` block
    // scalar would reintroduce both indentation bugs and `$` exposure: Cloud
    // Build expands `$FOO`/`$(...)` as its own substitutions before the step
    // runs, so a bare `$` in the YAML fails validation. This script contains no
    // `$` at all, which is the cheapest way to be right.
    `    args: ["-c", ${JSON.stringify(script)}]`,
    "options:",
    // No machineType, for the same measured reason as the Kaniko config above.
    "  logging: CLOUD_LOGGING_ONLY",
    ...buildTagsBlock(slug),
    "",
  ].join("\n");
}

/** The Cloud Build config for a Dockerfile build, per the BUILDER env var. */
export function cachedBuildConfig(image: string, builder: Builder = selectedBuilder(), slug?: string): string {
  return builder === "buildkit" ? buildkitBuildConfig(image, buildkitImage(), slug) : kanikoBuildConfig(image, slug);
}

/* -------------------------------------------------------------------------- */
/* Reading buildx's progress output                                           */
/*                                                                            */
/* Every regex below is pinned to a line captured from a real `docker buildx   */
/* build` run (buildx 0.8.2 and 0.23.0, registry cache, mode=max). The rule    */
/* learned the expensive way: buildx prints a *vertex label* when it starts a  */
/* step and the outcome on a later line, so the label is a statement of intent */
/* and never evidence of success. Matching a label is how this reported a      */
/* cache hit on builds that had no cache at all.                              */
/* -------------------------------------------------------------------------- */

/**
 * The first build for an app has no cache tag yet. buildx reports that as an
 * ERROR line and then continues to exit 0 — it must never be shown to the
 * customer as a failure, and it must never reach the repair agent, which would
 * chase it instead of the real error.
 *
 * Scoped to "not found" deliberately. The importer fails this way for reasons
 * that are *not* benign too — a missing artifactregistry.reader grant
 * (`unauthorized`), a deleted repo, an unreachable registry (`connection
 * refused`, captured verbatim in a real run) — and translating those into
 * "layer cache is cold" told the operator everything was fine while erasing the
 * only line that said what was wrong. Only the genuinely-first-build shape is
 * reassuring; every other importer failure now passes through as itself.
 */
export const CACHE_MISS_NOISE = /failed to (?:configure registry cache importer|compute cache key)[^\n]*\b(?:not found|404)\b/i;

/**
 * buildx's proof that the cache tag was found and read.
 *
 * NOT `importing cache manifest from` — that is the label buildx prints when it
 * *attempts* the import, and on a cold cache the very next line is
 * `ERROR: failed to configure registry cache importer: …: not found`. Verified
 * across six captured runs: the pair appears on every cold build (F1:23-24,
 * run1:23-24, B1:12-13) and `inferred cache manifest type` appears only on the
 * warm ones (F2:25, run2:28, B2:25). buildx also repeats the import label in its
 * closing error summary (`> importing cache manifest from …:`), so the old
 * regex announced a cache hit twice on a build that had none.
 *
 * `#N CACHED` is deliberately not treated as a registry-cache hit either: a cold
 * build on a warm *local* builder prints six of them (B1:24-39) without any
 * registry cache existing. Those lines still reach the customer as themselves,
 * via INTERESTING, which is honest — they just do not claim this cache worked.
 */
const CACHE_HIT = /inferred cache manifest type/i;

/**
 * buildx's proof that the cache really was written for the next build.
 *
 * NOT `exporting cache to registry`, for the same reason: that is the label, and
 * a captured run where the cache registry was unreachable prints it and then
 * `ERROR: error writing layer blob: …` (withignore.log:23,28) — the old regex
 * announced "layer cache updated" on an export that failed outright. Every run
 * whose export actually succeeded ends with `writing cache image manifest`
 * (F1:149, F2:156, run1:132, run2:104, B1:76, B2:156); the failed one never
 * reaches it.
 */
const CACHE_WRITE = /writing cache image manifest/i;

/**
 * The cache export failing. `ignore-error=true` keeps this off the build's exit
 * code, so it is not a deploy failure — but it is also not nothing: it means
 * every later build stays slow, silently, while claiming to be cached. The
 * string is the real one buildx emits; `cache export error`, which the previous
 * filter looked for, does not appear in any captured run.
 *
 * Not added to CACHE_MISS_NOISE on purpose: unlike a cold cache, this is a fact
 * about the environment that a repair agent reading a failed build should see.
 */
const CACHE_WRITE_FAILED = /error writing layer blob|failed to (?:push|export) cache/i;

/** The lines from a build that are worth showing a customer. */
const INTERESTING = /error|fail|step #|npm |next build|compiled|pushing|using cache|cached|denied|warming/i;

/**
 * Map one line of Cloud Build output to what the customer should see, or null to
 * drop it.
 *
 * Cache state gets translated rather than passed through, because buildx's own
 * wording is backwards from the customer's point of view: the cold-cache case is
 * printed as `ERROR:` (alarming, and it matches both `error` and `fail` in
 * INTERESTING) while the cache *hit* — the thing worth celebrating — is printed
 * as a line that matches nothing at all and would otherwise be invisible.
 */
export function buildLogLine(l: string): string | null {
  if (CACHE_MISS_NOISE.test(l)) return "layer cache is cold — this build warms it for the next deploy";
  if (CACHE_WRITE_FAILED.test(l)) return "! layer cache could not be written — the build is unaffected, the next one will not be faster";
  if (CACHE_HIT.test(l)) return "layer cache hit — reusing cached layers";
  if (CACHE_WRITE.test(l)) return "layer cache updated for the next deploy";
  return INTERESTING.test(l) ? l : null;
}

/* -------------------------------------------------------------------------- */
/* Prebuilt-runner prepare step                                               */
/* -------------------------------------------------------------------------- */

/**
 * Cloud Build config for the runner lane's ONE-TIME prepare step.
 *
 * It runs `supersonic-prepare` on the runner image (so the warm dependency cache
 * baked into that image applies), which installs the app's deps and builds it,
 * then tars everything — deps included — into `<release>.tgz`. The `artifacts`
 * block uploads that bundle to GCS. A serving Cloud Run instance later just
 * fetches the bundle and runs it, so it installs NOTHING on start — the cost is
 * paid once here, not on every new instance.
 *
 * No image is assembled or pushed: the deploy points at the shared runner image,
 * which already exists. That is the difference from the Dockerfile lane.
 *
 * SUPERSONIC_CACHE_* points prepare at a per-app cache object it restores before
 * install/build and saves after — so a redeploy reuses node_modules and the
 * framework build cache instead of doing both from scratch.
 */
export function runnerPrepareConfig(opts: { image: string; bucket: string; slug: string; release: string; codeKey: string; build?: string }): string {
  const out = `${opts.release}.tgz`;
  // The planner's build command (app-specific: e.g. `nx build … && prisma generate`)
  // overrides prepare.sh's `npm run build` convention. Base64 so any spaces/&&/quotes
  // ride the YAML env array untouched; prepare.sh decodes it. Present-but-empty means
  // "the planner decided there is no build step" — distinct from absent (use convention).
  const env = [
    `SUPERSONIC_OUT=${out}`,
    `SUPERSONIC_CACHE_BUCKET=${opts.bucket}`,
    `SUPERSONIC_CACHE_OBJECT=cache/${opts.slug}.tgz`,
    `SUPERSONIC_CODE_KEY=${opts.codeKey}`,
  ];
  if (opts.build !== undefined) env.push(`SUPERSONIC_BUILD_B64=${Buffer.from(opts.build).toString("base64")}`);
  // The per-app key encrypts the bundle before it lands in the shared bucket, so a
  // shared runtime SA that can read the bytes still can't read another app's source.
  return [
    "steps:",
    `  - name: ${opts.image}`,
    "    entrypoint: /usr/local/bin/supersonic-prepare",
    `    env: [${env.map((e) => `"${e}"`).join(", ")}]`,
    "options:",
    "  logging: CLOUD_LOGGING_ONLY",
    "artifacts:",
    "  objects:",
    `    location: gs://${opts.bucket}/ready/${opts.slug}/`,
    `    paths: ["${out}"]`,
    ...buildTagsBlock(opts.slug),
    "",
  ].join("\n");
}
