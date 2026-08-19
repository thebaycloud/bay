import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildImage, type BuildTarget, type BuildDeps } from "../lib/build-image";

/**
 * Building an image.
 *
 * Four behaviours here could not be checked at all while this was a closure in
 * the middle of runDeploy, and each of them is a way to ship the WRONG CODE
 * while reporting success — which is the failure this whole area keeps producing.
 */

const target = (over: Partial<BuildTarget> = {}): BuildTarget => ({
  dir: "/tmp/app",
  image: "us-central1-docker.pkg.dev/p/r/demo",
  hasDockerfile: true,
  serviceless: false,
  builder: "railpack",
  plannedWithRailpack: false,
  ...over,
});

function deps(over: Partial<BuildDeps> = {}) {
  const ran: Array<{ cmd: string; args: string[] }> = [];
  const logs: string[] = [];
  const base: BuildDeps = {
    log: (l) => logs.push(l),
    around: async (_stage, fn) => fn(),
    run: async (cmd, args) => { ran.push({ cmd, args }); },
    cloudBuildArgs: () => ["builds", "submit"],
    buildPlaneAddr: () => "tcp://10.128.0.5:1234",
    accessToken: async () => "tok",
    resolveDigest: async () => "sha256:" + "a".repeat(64),
    resetBuildLog: () => {},
    buildLog: async () => "",
    noteBuildLine: () => {},
    failureSentence: (h, r) => `${h}: ${r}`,
    ...over,
  };
  return { deps: base, ran, logs };
}

test("our own BuildKit runs only when Railpack planned the build", async () => {
  // Both conditions, never either. `buildctl` executes the plan through the
  // Railpack frontend, so an app that brought its own Dockerfile has nothing for
  // it to run — sending it there builds nothing and fails obscurely.
  const planned = deps();
  await buildImage(target({ plannedWithRailpack: true }), planned.deps);
  assert.equal(planned.ran[0].cmd, "buildctl", "a planned build belongs on the fleet's daemon");

  const unplanned = deps();
  await buildImage(target({ plannedWithRailpack: false }), unplanned.deps);
  assert.equal(unplanned.ran[0].cmd, "gcloud", "without a plan there is nothing for buildctl to run");

  // …and with no daemon configured, a planned build still has somewhere to go.
  const noPlane = deps({ buildPlaneAddr: () => null });
  await buildImage(target({ plannedWithRailpack: true }), noPlane.deps);
  assert.equal(noPlane.ran[0].cmd, "gcloud");
});

test("a build that cannot be resolved to a digest is a FAILURE, not a tag", async () => {
  // The sharpest one. `:latest` still names the PREVIOUS image at this moment,
  // so returning the tag would place last deploy's code and report this deploy
  // live — a wrong success, which is worse than any failure.
  const { deps: d } = deps({ resolveDigest: async () => null });

  const got = await buildImage(target(), d);

  assert.equal(got.ok, false);
  assert.match((got as { error: string }).error, /silently ship the previous version/);
});

test("the image is returned by digest, never by tag", async () => {
  const { deps: d } = deps({ resolveDigest: async () => "sha256:abc" });
  const got = await buildImage(target(), d);
  assert.deepEqual(got, { ok: true, image: "us-central1-docker.pkg.dev/p/r/demo@sha256:abc" });
});

test("the push credential is removed even when the build throws", async () => {
  // It is written so the daemon can push, and it is the daemon's only way in.
  // Leaving it behind after a failure turns a one-build window into a standing
  // credential on the control plane's disk.
  const configPath = join(homedir(), ".docker", "config.json");
  const before = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;

  const { deps: d } = deps({
    run: async () => { throw new Error("buildctl exited 1"); },
    buildLog: async () => "",
  });

  const got = await buildImage(target({ plannedWithRailpack: true }), d);

  assert.equal(got.ok, false);
  const after = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  assert.equal(after, before, "the credential written for this build must not outlive it");
});

test("a build with no push credential fails before it starts", async () => {
  const { deps: d, ran } = deps({ accessToken: async () => null });
  const got = await buildImage(target({ plannedWithRailpack: true }), d);
  assert.equal(got.ok, false);
  assert.deepEqual(ran, [], "nothing should be built with no way to push the result");
});

test("the failure reason falls through to the best source that has one", async () => {
  // An exit code is not a diagnosis, and the build log is often not fetchable at
  // the moment a build fails.
  const noise = Array.from({ length: 40 }, (_, i) => `#${i} extracting layer`);

  // 1. the build's own log wins
  const withLog = deps({
    run: async () => { throw new Error("exit 1"); },
    buildLog: async () => "ERROR: failed to solve: missing lockfile",
  });
  const a = await buildImage(target(), withLog.deps);
  assert.match((a as { error: string }).error, /missing lockfile/);

  // 2. no log — the lines that look like a cause, not the progress around them
  const withTail = deps({
    run: async (_c, _a, onLine) => {
      [...noise, "denied: permission on repository", ...noise].forEach(onLine);
      throw new Error("exit 1");
    },
    buildLog: async () => "",
  });
  const b = await buildImage(target(), withTail.deps);
  assert.match((b as { error: string }).error, /denied: permission/);
  assert.doesNotMatch((b as { error: string }).error, /extracting layer/);

  // 3. nothing that looks like a cause — the raw tail beats an exit code
  const rawOnly = deps({
    run: async (_c, _a, onLine) => { noise.forEach(onLine); throw new Error("exit 1"); },
    buildLog: async () => "",
  });
  const c = await buildImage(target(), rawOnly.deps);
  assert.match((c as { error: string }).error, /extracting layer/);
});

test("a lane with no image of its own is refused rather than built", async () => {
  const { deps: d, ran } = deps();
  const got = await buildImage(target({ hasDockerfile: false, serviceless: false }), d);
  assert.equal(got.ok, false);
  assert.match((got as { error: string }).error, /no image of its own/);
  assert.deepEqual(ran, []);
});
