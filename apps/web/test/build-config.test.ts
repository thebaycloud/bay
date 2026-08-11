import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cachedBuildConfig, kanikoBuildConfig, buildkitBuildConfig, selectedBuilder, RAILPACK_PLAN, mountsBuildSecrets,
  buildkitImage, buildLogLine, CACHE_MISS_NOISE, cloudBuildIdFrom, appBuildTag,
  runnerPrepareConfig,
} from "../lib/build-config";

const IMAGE = "us-central1-docker.pkg.dev/supersonic-deploy-prod/cloud-run-source-deploy/demo-app";

/**
 * Cloud Build expands `$FOO` and `$(...)` as its own substitutions before a step
 * runs, so a bare single `$` in the YAML fails validation with "key FOO is not a
 * valid built-in substitution". `$$` is the literal-dollar escape. This has
 * shipped broken once; this assertion is the automated defence.
 */
function assertNoBareDollar(yaml: string, what: string) {
  assert.equal(/(?<!\$)\$(?!\$)/.test(yaml), false, `${what} contains a bare single "$" — Cloud Build will reject it`);
}

/* -------------------------------------------------------------------------- */
/* Build-time secrets — the thing only the runner could do                     */
/* -------------------------------------------------------------------------- */

const DB = [{ key: "DATABASE_URL", name: "app-demo-DATABASE_URL" }];

test("kaniko refuses a build secret instead of baking it into the image", () => {
  // Its only channel is `--build-arg`, and an arg's value is readable in image
  // history — in an image pushed to a SHARED repository, exported to a mode=max
  // cache holding more layers than the image, and deleted by nothing. Passing it
  // anyway and saying nothing is how a database password becomes readable by
  // anyone who can pull the repo.
  assert.throws(
    () => kanikoBuildConfig(IMAGE, "demo", { secretEnv: DB }),
    (e: unknown) => e instanceof Error
      && /DATABASE_URL/.test(e.message)
      && /readable in the image's history/.test(e.message)
      && /BUILDER=buildkit/.test(e.message),   // the refusal names the one-line fix
  );
});

test("a build that needs a secret takes buildkit whatever BUILDER says", () => {
  // Narrow and stated: the alternative is refusing every deploy of every app that
  // reads its environment during the build, until the default flips.
  const yaml = cachedBuildConfig(IMAGE, "kaniko", "demo", { secretEnv: DB });
  assert.match(yaml, /docker buildx build/);
  assert.doesNotMatch(yaml, /kaniko/);
  // …and with nothing to mount, the default is byte-identical to today's.
  assert.equal(cachedBuildConfig(IMAGE, "kaniko", "demo", {}), kanikoBuildConfig(IMAGE, "demo"));
});

test("buildkit mounts the secret and never puts it on the command line", () => {
  const yaml = buildkitBuildConfig(IMAGE, null, "demo", { secretEnv: DB });

  // Cloud Build has to be told the step may see it at all…
  assert.match(yaml, /^availableSecrets:$/m);
  assert.match(yaml, /versionName: projects\/supersonic-deploy-prod\/secrets\/app-demo-DATABASE_URL\/versions\/latest/);
  assert.match(yaml, /^ {4}secretEnv: \["DATABASE_URL"\]$/m);
  // …and buildx reads it from a file, because `--secret id=K,env=K` needs buildx
  // 0.12 and this project has captured runs on 0.8.2.
  assert.match(yaml, /--secret id=DATABASE_URL,src=\/tmp\/ss-secret-DATABASE_URL/);
  assert.match(yaml, /printf '%s' \\"\$\$DATABASE_URL\\" > \/tmp\/ss-secret-DATABASE_URL/);

  // /tmp and NOT /workspace: /workspace is the build context, so a secret staged
  // there is a candidate for `COPY . .`, and it persists between steps.
  assert.doesNotMatch(yaml, /\/workspace\/ss-secret/);
  // The value itself is never in the YAML — only the name of the secret to fetch.
  assert.doesNotMatch(yaml, /postgres:\/\//);
  assertNoBareDollar(yaml, "buildkitBuildConfig with a secret");
});

test("a public build value is an arg, and its dollars are escaped", () => {
  // `NEXT_PUBLIC_*` has to be present when the bundler runs or the value never
  // reaches the shipped JavaScript. It is not secret, so an arg is right — and it
  // still has to survive Cloud Build's substitution pass.
  const args = [{ key: "PUBLIC_API", value: "https://api.example.com/$path" }];
  const kaniko = kanikoBuildConfig(IMAGE, "demo", { buildArgs: args });
  assert.match(kaniko, /--build-arg=PUBLIC_API=https:\/\/api\.example\.com\/\$\$path/);
  assertNoBareDollar(kaniko, "kaniko with a build arg");

  const buildkit = buildkitBuildConfig(IMAGE, null, "demo", { buildArgs: args });
  assert.match(buildkit, /--build-arg PUBLIC_API=/);
  assertNoBareDollar(buildkit, "buildkit with a build arg");
});

test("a build variable name that is not a name is refused, not interpolated", () => {
  // These strings land inside a shell line in a YAML document.
  for (const key of ["A B", "A;rm -rf /", "$(id)", "", "1BAD"]) {
    assert.throws(() => buildkitBuildConfig(IMAGE, null, "demo", { secretEnv: [{ key, name: "x" }] }), /not a usable name/);
    assert.throws(() => kanikoBuildConfig(IMAGE, "demo", { buildArgs: [{ key, value: "x" }] }), /not a usable name/);
  }
});

test("one app can take buildkit without every app taking it", () => {
  // docs/CUTOVER.md:369-378: registry auth for `--push` is unverified, and if it
  // fails "every Dockerfile deploy fails with `denied` … total failure of the
  // lane". `BUILDER` lives in the deploy JOB's environment, which every deploy
  // shares — so testing the change on one app by setting it would first apply it
  // to all of them. A canary that cannot be scoped is the rollout with a smaller
  // word.
  const env = { BUILDKIT_APPS: "demo,other" };
  assert.equal(selectedBuilder(env, "demo"), "buildkit");
  assert.equal(selectedBuilder(env, "other"), "buildkit");
  assert.equal(selectedBuilder(env, "someone-else"), "kaniko");
  assert.equal(selectedBuilder(env), "kaniko", "no slug means no canary, not every canary");

  // Whitespace and empties, because this is set by hand on a Cloud Run job.
  assert.equal(selectedBuilder({ BUILDKIT_APPS: " demo , " }, "demo"), "buildkit");
  assert.equal(selectedBuilder({ BUILDKIT_APPS: "" }, "demo"), "kaniko");
  assert.equal(selectedBuilder({}, "demo"), "kaniko");

  // The global switch still wins for everyone, so the canary is additive.
  assert.equal(selectedBuilder({ BUILDER: "buildkit" }, "anything"), "buildkit");
});

test("BUILDER defaults to kaniko and only 'buildkit' switches it", () => {
  assert.equal(selectedBuilder({}), "kaniko");
  assert.equal(selectedBuilder({ BUILDER: "" }), "kaniko");
  assert.equal(selectedBuilder({ BUILDER: "kaniko" }), "kaniko");
  assert.equal(selectedBuilder({ BUILDER: "BuildKit" }), "kaniko", "the gate is exact-match, not fuzzy");
  assert.equal(selectedBuilder({ BUILDER: "buildkit" }), "buildkit");

  // The default must be byte-identical to what production runs today.
  assert.equal(cachedBuildConfig(IMAGE, selectedBuilder({})), kanikoBuildConfig(IMAGE));
  assert.equal(cachedBuildConfig(IMAGE, "buildkit"), buildkitBuildConfig(IMAGE));
});

test("the kaniko config is unchanged and still substitution-safe", () => {
  const yaml = kanikoBuildConfig(IMAGE);
  assert.match(yaml, /gcr\.io\/kaniko-project\/executor:latest/);
  assert.match(yaml, /--cache=true/);
  assert.ok(yaml.includes(`--destination=${IMAGE}:latest`));
  assert.ok(yaml.includes(`--cache-repo=${IMAGE}-cache`));
  assert.doesNotMatch(yaml, /machineType/, "a non-default machine costs ~50s of provisioning");
  assertNoBareDollar(yaml, "kanikoBuildConfig");
});

test("the buildkit config exports a mode=max registry cache that cannot fail the build", () => {
  const yaml = buildkitBuildConfig(IMAGE);

  // mode=max is the entire migration: mode=min would drop the `npm install`
  // layer, which lives in a build stage that never reaches the final image.
  assert.match(yaml, /mode=max/);
  // Without ignore-error a cache push that cannot reach the registry fails the
  // whole deploy, which then gets handed to the repair agent.
  assert.match(yaml, /ignore-error=true/);
  // The default `docker` driver cannot export a registry cache at all.
  assert.match(yaml, /buildx create --use/);
  assert.match(yaml, /--driver docker-container/);

  assert.ok(yaml.includes(`--cache-from type=registry,ref=${IMAGE}-cache:cache`));
  assert.ok(yaml.includes(`--cache-to type=registry,ref=${IMAGE}-cache:cache,mode=max,ignore-error=true`));
  assert.ok(yaml.includes(`-t ${IMAGE}:latest`), "the tag gcloud run deploy consumes");
  assert.match(yaml, /--push/);
  // An unknown *flag* is a hard failure on old buildx (`unknown flag:
  // --provenance`, exit 125); an unknown env var is ignored.
  assert.doesNotMatch(yaml, /--provenance/);
  assert.match(yaml, /BUILDX_NO_DEFAULT_ATTESTATIONS=1/);
  assert.doesNotMatch(yaml, /machineType/);

  assertNoBareDollar(yaml, "buildkitBuildConfig");
});

test("the buildkit script fails loudly if the buildx plugin is missing", () => {
  const yaml = buildkitBuildConfig(IMAGE);
  const script = JSON.parse(yaml.match(/args: \["-c", (".*")\]/)![1]) as string;
  assert.ok(script.startsWith("docker buildx version &&"), "the version probe must be first, so a missing plugin dies on line 1");
  assert.equal(script.includes("$"), false);
});

test("a cold cache reads as informational", () => {
  const cold = "#6 ERROR: failed to configure registry cache importer: us-central1-docker.pkg.dev/p/r/demo-app-cache:cache: not found";
  // It matches /error/ and /fail/, so without the translation the customer sees
  // a red line on a build that succeeded.
  assert.match(cold, /error|fail/i);
  assert.equal(buildLogLine(cold), "layer cache is cold — this build warms it for the next deploy");
  assert.equal(CACHE_MISS_NOISE.test(cold), true, "the same line must be kept out of what the repair agent reads");
});

/* ------------------------------------------------------------------ *
 * Cache state, read off real buildx output.
 *
 * Each of the sequences below is copied from a captured `docker buildx
 * build` run against a registry cache. They are here because the
 * previous filter matched buildx's *labels* — the line it prints when it
 * starts a step — which are printed identically whether the step then
 * succeeds or fails. Asserting on a label in isolation is exactly what
 * let "layer cache hit" ship for builds that had no cache.
 * ------------------------------------------------------------------ */

/** Feed a whole log through the customer-facing filter, as route.ts does. */
function stream(log: string): string[] {
  return log.split("\n").map(buildLogLine).filter((l): l is string => l !== null);
}

test("a cold build never claims a cache hit", () => {
  // Verbatim from a real cold run: the label, then the failure, on consecutive
  // lines. The old CACHE_HIT matched the first and announced a hit.
  const cold = [
    "#6 importing cache manifest from host.docker.internal:5001/demo-app-cache:cache",
    "#6 ERROR: failed to configure registry cache importer: host.docker.internal:5001/demo-app-cache:cache: not found",
    "#6 CANCELED",
  ].join("\n");

  const out = stream(cold);
  assert.equal(out.some((l) => /cache hit/.test(l)), false, "no hit may be claimed on a build with no cache");
  assert.deepEqual(out, ["layer cache is cold — this build warms it for the next deploy"]);
});

test("buildx's closing error summary does not resurrect the false hit", () => {
  // The same label again, at the end of the run, inside the error block.
  assert.equal(buildLogLine(" > importing cache manifest from host.docker.internal:5001/demo-app-cache:cache:"), null);
});

test("a warm build's hit is announced, on the line that proves it", () => {
  // `inferred cache manifest type` appears only after the manifest was really
  // fetched and parsed — it is absent from every captured cold run.
  const warm = [
    "#6 importing cache manifest from host.docker.internal:5001/demo-app-cache:cache",
    "#6 inferred cache manifest type: application/vnd.oci.image.manifest.v1+json done",
    "#6 DONE 0.0s",
  ].join("\n");

  assert.deepEqual(stream(warm), ["layer cache hit — reusing cached layers"]);
});

test("a cold build on a warm local builder does not count as a registry hit", () => {
  // A real cold run printed six `CACHED` lines from the builder's own local
  // state while the registry cache did not exist at all.
  assert.equal(buildLogLine("#7 CACHED"), "#7 CACHED", "shown as itself, claiming nothing");
});

test("the cache write is announced only when it actually happened", () => {
  // The label, which a failed export prints too.
  assert.equal(buildLogLine("#15 exporting cache to registry"), null);
  // The line only a successful export reaches.
  assert.equal(buildLogLine("#15 writing cache image manifest sha256:fa73a5c0 0.0s done"),
    "layer cache updated for the next deploy");
});

test("a cache export that failed says so instead of claiming success", () => {
  // Captured with the cache registry unreachable. `ignore-error=true` keeps the
  // build at exit 0, so the customer previously saw "layer cache updated" plus a
  // raw red ERROR on a build that succeeded and cached nothing.
  const failed = [
    "#7 exporting cache to registry",
    '#7 ERROR: error writing layer blob: failed to do request: Head "http://localhost:5999/v2/nope-cache/blobs/sha256:025fe19": dial tcp 127.0.0.1:5999: connect: connection refused',
  ].join("\n");

  const out = stream(failed);
  assert.equal(out.some((l) => /cache updated/.test(l)), false);
  assert.deepEqual(out, ["! layer cache could not be written — the build is unaffected, the next one will not be faster"]);
});

test("a cache failure that is not a cold cache is not disguised as one", () => {
  // An unreachable registry and a missing reader grant both come out of the
  // importer, and neither means "first build". Translating them lost the only
  // line that said what was actually wrong.
  const unreachable = '#4 ERROR: failed to configure registry cache importer: failed to do request: Head "http://localhost:5999/v2/nope-cache/manifests/cache": dial tcp: connect: connection refused';
  const unauthorized = "#4 ERROR: failed to configure registry cache importer: us-central1-docker.pkg.dev/p/r/x-cache:cache: unexpected status: 403 Forbidden";

  for (const line of [unreachable, unauthorized]) {
    assert.equal(CACHE_MISS_NOISE.test(line), false, "the repair agent must still get to read this");
    assert.equal(buildLogLine(line), line, "shown verbatim, not as 'cache is cold'");
  }
});

test("the BuildKit daemon image can be pinned off Docker Hub", () => {
  // Unset by default: an AR mirror that does not exist yet must not be able to
  // take deploys down. But the lever has to be there, because the default is a
  // Docker Hub pull on the critical path of every container build.
  assert.equal(buildkitImage({}), null);
  assert.equal(buildkitImage({ BUILDKIT_IMAGE: "  " }), null);
  assert.equal(buildkitImage({ BUILDKIT_IMAGE: "us-central1-docker.pkg.dev/p/r/buildkit:v0.23" }),
    "us-central1-docker.pkg.dev/p/r/buildkit:v0.23");
  // A `$` here would reach the Cloud Build YAML and fail validation.
  assert.equal(buildkitImage({ BUILDKIT_IMAGE: "evil:$(whoami)" }), null);

  assert.doesNotMatch(buildkitBuildConfig(IMAGE, null), /--driver-opt/);
  const pinned = buildkitBuildConfig(IMAGE, "us-central1-docker.pkg.dev/p/r/buildkit:v0.23");
  assert.match(pinned, /--driver docker-container --driver-opt image=us-central1-docker\.pkg\.dev\/p\/r\/buildkit:v0\.23/);
  assertNoBareDollar(pinned, "buildkitBuildConfig with a pinned daemon image");
});

test("real build output still reaches the customer, noise still does not", () => {
  assert.equal(buildLogLine("added 214 packages in 9s"), null, "npm's own summary has no leading 'npm '");
  assert.equal(buildLogLine("npm warn deprecated inflight@1.0.6"), "npm warn deprecated inflight@1.0.6");
  assert.equal(buildLogLine("Error: Module not found: './missing'"), "Error: Module not found: './missing'");
  assert.equal(buildLogLine("denied: Permission \"artifactregistry.repositories.uploadArtifacts\" denied"), "denied: Permission \"artifactregistry.repositories.uploadArtifacts\" denied");
  assert.equal(buildLogLine("#4 transferring context: 2.1MB"), null);
  assert.equal(buildLogLine("Creating temporary archive of 41 file(s)"), null);
});

/**
 * Which build was MINE.
 *
 * The implementation this replaced asked "what was the last build in the
 * project?" (`gcloud builds list --limit 1`, no filter). Under any concurrency at
 * all that is somebody else's build, and the log is not decoration: it is the
 * evidence the repair agent debugs from, so a stranger's failure sends the agent
 * editing this customer's code over a bug that was never in it. Every line below
 * is copied from real gcloud output.
 */
test("a deploy can identify its own Cloud Build", () => {
  const id = "d3f4a1b2-9c8d-4e7f-a6b5-0123456789ab";

  // `gcloud builds submit` — the static, runner and Dockerfile lanes.
  assert.equal(cloudBuildIdFrom(
    `Logs are available at [https://console.cloud.google.com/cloud-build/builds;region=us-central1/${id}?project=540236122367].`), id);
  assert.equal(cloudBuildIdFrom(
    `Created [https://cloudbuild.googleapis.com/v1/projects/supersonic-deploy-prod/locations/us-central1/builds/${id}].`), id);
  // `gcloud run deploy --source` — the buildpack lane, whose build we never
  // configure and therefore cannot tag. This line is its only identification.
  assert.equal(cloudBuildIdFrom(
    `Building Container... Logs are available at [https://console.cloud.google.com/cloud-build/builds;region=us-central1/${id}?project=p].`), id);

  // A deploy's output is full of OTHER uuids. Answering with one of those would
  // be exactly the bug this fixes, just sourced differently.
  assert.equal(cloudBuildIdFrom("Creating Revision... operation 4a1b2c3d-5e6f-4071-8293-a4b5c6d7e8f9"), null);
  assert.equal(cloudBuildIdFrom("Setting IAM policy for request 4a1b2c3d-5e6f-4071-8293-a4b5c6d7e8f9"), null);
  assert.equal(cloudBuildIdFrom("Creating temporary archive of 41 file(s)"), null);
  assert.equal(cloudBuildIdFrom("Logs are available at [https://console.cloud.google.com/cloud-build/builds]"), null);
});

test("every config we generate is tagged with its app", () => {
  // The fallback when no id was printed: this app's own most recent build. It
  // only works if the tag is actually on the builds we submit.
  const tag = appBuildTag("demo-app");
  assert.equal(tag, "supersonic-app-demo-app");
  // Cloud Build rejects a tag outside [\w][\w.-]{0,127} at submit — i.e. the tag
  // being wrong takes the deploy down, not just the log lookup.
  assert.match(tag, /^[\w][\w.-]{0,127}$/);

  for (const [lane, yaml] of [
    ["kaniko", kanikoBuildConfig(IMAGE, "demo-app")],
    ["buildkit", buildkitBuildConfig(IMAGE, null, "demo-app")],
    ["cached/kaniko", cachedBuildConfig(IMAGE, "kaniko", "demo-app")],
    ["cached/buildkit", cachedBuildConfig(IMAGE, "buildkit", "demo-app")],
    ["runner prepare", runnerPrepareConfig({ image: "r", bucket: "b", slug: "demo-app", release: "rel", codeKey: "k" })],
  ] as const) {
    assert.match(yaml, /^tags:\n  - supersonic-app-demo-app$/m, `${lane} must tag its build`);
  }

  // No slug (a caller that has none yet) must not emit a malformed empty block.
  assert.doesNotMatch(kanikoBuildConfig(IMAGE), /tags:/);
});

// Railpack is a third lane, canaried the same way and for the same reason. The
// failure it is probing is different from buildkit's: not registry auth, but
// whether Railpack's detection agrees with ours about what an app IS. That
// answer varies per repository, so unlike the buildkit rollout — where one app
// either proved the IAM grant or disproved it for everyone — this one genuinely
// has to walk through apps one at a time.
test("railpack is a lane of its own, and one app can take it alone", () => {
  const env = { RAILPACK_APPS: "demo" };
  assert.equal(selectedBuilder(env, "demo"), "railpack");
  assert.equal(selectedBuilder(env, "other"), "kaniko", "a railpack canary moves one app, not the default");
  assert.equal(selectedBuilder({ BUILDER: "railpack" }, "anything"), "railpack");

  // Both lists naming the same app: railpack wins, because it is the newer and
  // narrower instruction and because buildkit is what railpack runs on anyway —
  // the frontend is executed by the same buildx step. Silently preferring
  // buildkit would make a railpack canary look like it ran when it did not.
  assert.equal(selectedBuilder({ BUILDKIT_APPS: "demo", RAILPACK_APPS: "demo" }, "demo"), "railpack");
});

// The union grew and the dispatch is a ternary, not an exhaustive switch, so
// `railpack` fell through to Kaniko — and tsc was happy, because falling into
// the wrong branch of a correct ternary is not a type error. A railpack canary
// would have built a Dockerfile with Kaniko and reported success.
test("the railpack lane is buildx, and cannot quietly become Kaniko", () => {
  const c = cachedBuildConfig("img", "railpack", "demo");
  assert.equal(c.includes("docker buildx build"), true, "railpack runs as a buildx frontend");
  assert.equal(c.includes("kaniko"), false);
});

// Both halves are supplied by the lane rather than by its caller. Passing one
// without the other is the failure this prevents: `-f railpack-plan.json` with
// no BUILDKIT_SYNTAX hands a build plan to the Dockerfile parser, which fails on
// the first `{` with a syntax error that names neither Railpack nor the plan.
test("the railpack lane supplies both the frontend and the plan, or neither", () => {
  const c = cachedBuildConfig("img", "railpack", "demo");
  assert.equal(c.includes("BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend"), true);
  assert.equal(c.includes(`-f ${RAILPACK_PLAN}`), true);
  assert.equal(c.includes("-f Dockerfile"), false);

  // And the other lanes are untouched — they still build a Dockerfile.
  assert.equal(cachedBuildConfig("img", "buildkit", "demo").includes("-f Dockerfile"), true);
  assert.equal(cachedBuildConfig("img", "buildkit", "demo").includes("BUILDKIT_SYNTAX"), false);
});

// Two more sites in deploy-pipeline.ts asked `builder === "buildkit"` when the
// question they meant was "can this lane mount a secret without baking it into
// the image?". Kaniko cannot — its only channel is `--build-arg`, whose values
// stay readable in the history of an image pushed to a SHARED repository. That
// is why the check exists.
//
// Railpack IS buildx, so it can. Left as an equality, a railpack build of a
// Prisma app would have dropped its build secret and reported success — the
// same shape as the Kaniko fall-through above, one file over.
test("the question is what a lane can mount, not what it is called", () => {
  assert.equal(mountsBuildSecrets("buildkit"), true);
  assert.equal(mountsBuildSecrets("railpack"), true, "railpack is buildx with a frontend");
  assert.equal(mountsBuildSecrets("kaniko"), false, "no --mount=type=secret, and --build-arg is not a substitute");
});
