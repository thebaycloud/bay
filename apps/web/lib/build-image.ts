import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildctlArgs, dockerAuthConfig } from "./buildplane";

/**
 * Turning a checkout into an image a node can pull, and saying what it is BY
 * DIGEST.
 *
 * Two builders, and the choice between them is the module's first real claim.
 * Cloud Build is the general one. The fleet's own BuildKit — a long-lived daemon
 * with its cache on local SSD — is faster by an order of magnitude and can only
 * run a RAILPACK PLAN: `buildctl` executes the plan through the Railpack
 * frontend, so an app that brought its own Dockerfile has nothing for it to run.
 * Both conditions, never either.
 *
 * The second claim is the return value. A build that pushed `:latest` and cannot
 * be resolved to a digest is a FAILED build here, not a successful one that
 * returns the tag. Placing the tag would silently ship whatever `:latest` named
 * a moment ago — the previous version — while reporting the new one live.
 */

/** What to build, and what the answer depends on. */
export interface BuildTarget {
  /** The checkout. Also the Cloud Build context. */
  dir: string;
  /** Where the image is pushed, with no tag. */
  image: string;
  /**
   * Whether a Dockerfile exists to build from — the author's or one the platform
   * generated. False means the image is produced by buildpacks instead.
   */
  hasDockerfile: boolean;
  /** True when the app declares only non-web processes. */
  serviceless: boolean;
  /** Which builder was selected, for the line the user reads. */
  builder: string;
  /**
   * Whether Railpack planned this build.
   *
   * The gate on the fleet's own BuildKit, and not a preference: `buildctl` runs
   * the plan through Railpack's frontend and has nothing to do without one.
   */
  plannedWithRailpack: boolean;
}

export interface BuildDeps {
  log: (line: string) => void;
  around: <T>(stage: string, fn: () => Promise<T>) => Promise<T>;
  /** Runs a command, streaming every line to `onLine`. Rejects on a non-zero exit. */
  run: (cmd: string, args: string[], onLine: (l: string) => void) => Promise<unknown>;
  /** Cloud Build argv for this target, when Cloud Build is the builder. */
  cloudBuildArgs: (target: BuildTarget) => string[];
  /** Address of the fleet's BuildKit, or null when there is none. */
  buildPlaneAddr: () => string | null;
  /** A registry push credential, or null. */
  accessToken: () => Promise<string | null>;
  /** What `<image>:latest` now names, or null if the registry will not say. */
  resolveDigest: (ref: string) => Promise<string | null>;
  /** Called before a build so a retry cannot read the previous attempt's log. */
  resetBuildLog: () => void;
  /** The build's own log, once it is fetchable. Empty when it is not. */
  buildLog: () => Promise<string>;
  /** Every raw line, for the watcher that scrapes the build id out of it. */
  noteBuildLine: (line: string) => void;
  failureSentence: (headline: string, reason: string) => string;
}

export type BuildOutcome =
  | { ok: true; image: string }
  | { ok: false; error: string };

/** How many trailing build lines are kept as evidence when the log cannot be read. */
const TAIL = 60;
/** Lines that look like a cause rather than progress. */
const CAUSE = /error|invalid|denied|must|logging|permission|quota|not found/i;

export async function buildImage(target: BuildTarget, deps: BuildDeps): Promise<BuildOutcome> {
  if (!target.hasDockerfile && !target.serviceless) {
    // A refusal rather than a shrug. This is the shape whose image is produced as
    // a side effect of a deploy and named by whatever ran it, so at this point
    // there is nothing to build and nothing to name — and placing an image nobody
    // built is exactly what asking here is meant to prevent.
    return { ok: false, error: "this lane has no image of its own to build before the deploy" };
  }

  // Kept for the error path: `gcloud builds submit` reports a failure in its own
  // output long before the build log is fetchable, and these lines are the only
  // diagnosis available when the log read fails.
  const tail: string[] = [];
  const onLine = (l: string) => {
    tail.push(l);
    if (tail.length > TAIL) tail.shift();
    deps.noteBuildLine(l);
  };

  try {
    await deps.around("build", async () => {
      // BOTH conditions, never either — see `plannedWithRailpack`.
      const plane = target.plannedWithRailpack ? deps.buildPlaneAddr() : null;
      deps.log(plane
        ? "Building on the fleet's own BuildKit — its cache is local and stays warm…"
        : target.hasDockerfile
          ? `Building with layer cache (${target.builder}) — the first build warms it, later ones are fast…`
          : "Building with buildpacks — no service to deploy, so the image is built directly…");

      deps.resetBuildLog();
      if (plane) await onOurBuildKit(target, plane, onLine, deps);
      else await deps.run("gcloud", deps.cloudBuildArgs(target), onLine);
    });
  } catch (e) {
    return { ok: false, error: deps.failureSentence("Build failed", await reasonFor(e, tail, deps)) };
  }

  const digest = await deps.resolveDigest(`${target.image}:latest`);
  if (!digest) {
    // OURS, not the repository's. Worded so `classify` blames the platform:
    // sending a repair agent to edit a customer's app over a registry that would
    // not answer costs real money and finds nothing.
    return {
      ok: false,
      error: `the image digest could not be resolved: the build pushed ${target.image}:latest, `
        + `and the registry did not say which image that now names. `
        + `Deploying the tag instead would silently ship the previous version.`,
    };
  }
  deps.log(`Built ${digest.slice(0, 19)}… — deployed by digest, so "the new version" is a fact rather than a tag.`);
  return { ok: true, image: `${target.image}@${digest}` };
}

/**
 * A build on the fleet's own daemon.
 *
 * The push credential travels from HERE to the daemon, which is what keeps the
 * build host free of standing push credentials. Written before and removed
 * after — including after a failure, which is why the `finally` is not optional:
 * a token on disk for the length of one build is a far smaller window than one
 * baked into an image, and this file is the daemon's only way in.
 *
 * No build args are passed, and not because they are unavailable: on this lane
 * they were already baked into the PLAN by `railpack prepare --env`. Passing them
 * again would be a second source for one fact.
 */
async function onOurBuildKit(
  target: BuildTarget,
  addr: string,
  onLine: (l: string) => void,
  deps: BuildDeps,
): Promise<void> {
  const token = await deps.accessToken();
  if (!token) throw new Error("no credentials to push the built image with");

  const dockerDir = join(homedir(), ".docker");
  mkdirSync(dockerDir, { recursive: true });
  writeFileSync(join(dockerDir, "config.json"),
    dockerAuthConfig(target.image.split("/")[0], token), { mode: 0o600 });
  try {
    await deps.run("buildctl", buildctlArgs({ dir: target.dir, image: target.image, addr }), onLine);
  } finally {
    try { unlinkSync(join(dockerDir, "config.json")); } catch { /* gone is fine */ }
  }
}

/**
 * Why the build failed, from the best source that has an answer.
 *
 * Three fallbacks, in descending order of usefulness, because the build log is
 * often not fetchable at the moment a build fails and an exit code is not a
 * diagnosis. The filtered tail comes before the raw one so a wall of progress
 * output does not bury the single line that says `permission denied`.
 */
async function reasonFor(e: unknown, tail: string[], deps: BuildDeps): Promise<string> {
  const log = await deps.buildLog();
  return log
    || tail.filter((l) => CAUSE.test(l)).slice(-6).join("\n")
    || tail.slice(-6).join("\n")
    || (e instanceof Error ? e.message : String(e));
}
