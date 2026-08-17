import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ASSETS_BUCKET, releaseId, releasePrefix } from "./static-release";
import { staticBuildConfig } from "./static-build";

/**
 * Publishing a static site: build it, upload it, PROVE it arrived, then name it.
 *
 * The order is the whole module. A green Cloud Build is not evidence that
 * anything was uploaded — the step that copies the assets can exit 0 having
 * copied nothing — and that is exactly how a pointer once came to name a release
 * that does not exist. So the release is read back before it is allowed to go
 * live, and the pointer is written last. A failure anywhere above leaves the
 * PREVIOUS release live and untouched, which is the property that makes a failed
 * static deploy harmless.
 *
 * lib/static-release.ts used to carry a `publishRelease` that uploaded and then
 * named, with nothing between. It was never called and is now deleted; the note
 * there says why adopting it would have been a regression rather than a tidy-up.
 *
 * The parameters are grouped rather than flat, and the grouping is not cosmetic:
 * inline in `runDeploy` this read thirteen values out of the enclosing scope, and
 * a thirteen-parameter function is a worse interface than the closure was. Three
 * arguments, each one thing a reader already has a name for.
 */

/** Who this is for. Decides where a build's dependency cache may be read back. */
export interface StaticApp {
  slug: string;
  ownerId: string;
  /**
   * Namespaces the build cache.
   *
   * A build's dependency tarball may only ever be read back by the tenant that
   * produced it: it is not a dependency graph, it is one project's node_modules
   * including whatever its postinstall scripts left in there.
   */
  workspaceId: string | null;
}

/** What to publish, and how it is made. */
export interface StaticSource {
  /** The checkout. */
  dir: string;
  /** Which directory under `dir` holds the site once the build has run. */
  outputDir: string;
  installCommand: string | null;
  buildCommand: string | null;
  /**
   * Whether `installCommand` came from a plan rather than the detector.
   *
   * A command the plan supplied is run EXACTLY as written. The npm flags this
   * module appends otherwise are a convenience for the command the DETECTOR
   * generates, and appending them to somebody else's is wrong twice over:
   * `pip install -r requirements.txt --no-audit` is not a command, and
   * `(cd frontend && npm ci) --prefer-offline` is a syntax error — a subdirectory
   * command is a subshell and nothing can follow its closing paren. Both were
   * produced by trying to be helpful with a string we did not write.
   */
  installVerbatim: boolean;
}

/** The world this needs to touch. Injected so the order above can be tested. */
export interface PublishDeps {
  log: (line: string) => void;
  /** Times a phase under a stage name. */
  around: <T>(stage: string, fn: () => Promise<T>) => Promise<T>;
  /** Submits a Cloud Build for the directory. Rejects on failure. */
  submitBuild: (dir: string, configPath: string) => Promise<void>;
  /** Copies a local directory to `gs://…`. Rejects on failure. */
  uploadDir: (source: string, destination: string) => Promise<void>;
  /** Rejects unless the release is readable at `prefix`. */
  assertUploaded: (prefix: string, destination: string) => Promise<void>;
  /** Names the live release. Called LAST, and only after `assertUploaded`. */
  writePointer: (slug: string, release: string) => Promise<void>;
  /** The build log, for a failure whose own message says nothing useful. */
  buildError: () => Promise<string>;
  /** The shared static server's URL, which every static app is served from. */
  upstreamUrl: () => Promise<string | null>;
  /** Wraps a reason in the sentence the user sees. */
  failureSentence: (headline: string, reason: string) => string;
}

export type PublishOutcome = { ok: true; url: string } | { ok: false; error: string };

export async function publishStatic(
  app: StaticApp,
  source: StaticSource,
  deps: PublishDeps,
): Promise<PublishOutcome> {
  const release = releaseId();
  const prefix = releasePrefix(app.slug, release);
  const destination = `gs://${ASSETS_BUCKET}/${prefix}`;
  const needsBuild = Boolean(source.installCommand || source.buildCommand);

  try {
    if (needsBuild) {
      await deps.around("build", async () => {
        deps.log("Building assets…");
        const config = join(source.dir, "cloudbuild.yaml");
        writeFileSync(config, staticBuildConfig({
          installCommand: installFor(source),
          buildCommand: source.buildCommand,
          outputDir: source.outputDir,
          destination,
          namespace: app.workspaceId ?? app.ownerId,
          slug: app.slug,
        }));
        await deps.submitBuild(source.dir, config);
      });
    } else {
      // Nothing to build — the directory already IS the site, so it goes
      // straight up and skips Cloud Build entirely.
      await deps.around("upload", async () => {
        deps.log("Uploading…");
        const from = join(source.dir, source.outputDir);
        // Checked before the copy, because `rsync` from a directory that is not
        // there fails in a way nothing downstream can explain: this lane runs no
        // Cloud Build, so there is no build log to fall back on and the deploy
        // reports `gcloud exited 1` with no cause anywhere. Saying which
        // directory was expected is the whole diagnosis.
        if (!existsSync(from)) {
          throw new Error(
            `this site has no \`${source.outputDir}\` directory to publish.\n` +
            `The files to serve should be at the repository root, or in the directory the build writes.`,
          );
        }
        await deps.uploadDir(from, destination);
      });
    }
  } catch (e) {
    const buildLog = await deps.buildError();
    const reason = buildLog || (e instanceof Error ? e.message : String(e));
    return { ok: false, error: deps.failureSentence("Build failed", reason) };
  }

  try {
    await deps.around("verify", async () => {
      deps.log("Checking the build…");
      await deps.assertUploaded(prefix, destination);
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // Last, and only now: the release is complete, so it may be named.
  await deps.writePointer(app.slug, release);
  deps.log(`Published release ${release}`);

  // The proxy routes by looking up apps.run_url, so a static app points at the
  // shared static server. The proxy tells that server which app a request is for
  // via `x-supersonic-slug`, because it drops Host on the way through and every
  // static app shares this one upstream.
  const upstream = await deps.upstreamUrl();
  if (!upstream) return { ok: false, error: "the shared static server has no URL — is it deployed?" };
  return { ok: true, url: upstream };
}

/** See `StaticSource.installVerbatim` for why this is not always the flags. */
function installFor(source: StaticSource): string | null {
  if (!source.installCommand) return null;
  return source.installVerbatim
    ? source.installCommand
    : `${source.installCommand} --prefer-offline --no-audit --no-fund`;
}
