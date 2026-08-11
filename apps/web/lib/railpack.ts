import type { BuildSpec } from "@/lib/detect";

/**
 * Our `BuildSpec` expressed as a `railpack.json`.
 *
 * WHAT THIS IS FOR. `lib/dockerfile.ts` is 635 lines that decide base images,
 * order install layers so they cache, and emit a Dockerfile. Railpack does that
 * work — with mise for toolchain versions and named BuildKit caches per package
 * manager — and does it better, because it is the thing Railway maintains full
 * time against every language they see. Handing it the build is how those 635
 * lines stop being ours to keep correct.
 *
 * WHAT THIS IS NOT FOR, which matters more. Railpack's config schema has no
 * `release`, no `framework`, no `database` and no notion of confidence. Those
 * are not omissions to work around; they are platform concerns that Railway
 * handles in the layer above Railpack, exactly as we do:
 *
 *   `framework`   → `framework-env.ts` turns it into ALLOWED_HOSTS,
 *                   CSRF_TRUSTED_ORIGINS, NEXTAUTH_URL and ROOT_PATH. Django
 *                   answers 400 to EVERY request when Host is not in that list.
 *   `release`     → the one-shot migration that must finish before traffic moves.
 *   `database`    → what we provision before the app ever starts.
 *   `confidence`  → whether we deploy, ask the user, or call a model.
 *
 * So `detect()` stays. This module is the seam between the two: everything the
 * repository can tell you about HOW TO BUILD becomes Railpack's problem, and
 * everything about WHAT THIS APP IS remains ours.
 *
 * THE PRECEDENCE RULE, stated once. Where both could have an opinion, ours wins
 * — not because it is better, but because ours has seen things Railpack cannot:
 * the `--run` flag typed at deploy time, `supersonic.json`, and the answer a
 * user gave to a question we asked. Railpack sees a directory. It is authoritative
 * about toolchains and layer caching precisely because those are read off that
 * directory, and it is not authoritative about anything that arrived later.
 */

/** The subset of `railpack.json` we emit. Keys are from `railpack schema` (0.36.3). */
export interface RailpackConfig {
  $schema?: string;
  /**
   * Forces the language provider. Absent means Railpack detects it, which is the
   * common case and the desirable one — see the precedence rule above.
   */
  provider?: string;
  /** apt packages the BUILD needs — our `BuildSpec.needs`. */
  buildAptPackages?: string[];
  /** Toolchain pins, as `{ node: "22" }`. mise resolves them. */
  packages?: Record<string, string>;
  /** Build-context exclusions, the `.dockerignore` equivalent. */
  exclude?: string[];
  deploy?: {
    startCommand?: string;
    variables?: Record<string, string>;
    aptPackages?: string[];
  };
}

export interface RailpackInput {
  /** What `detect()` concluded, after `--run` and `supersonic.json` were applied. */
  spec: BuildSpec;
  /**
   * `frameworkBuildEnv` — values baked into the bundle, which therefore have to
   * be present while it is being bundled.
   *
   * Deliberately NOT `deploymentEnv`. Everything there is derived from the
   * hostname the app answers on, and an image is not per-hostname: the same image
   * is what a rollback re-places and what a second replica runs. Runtime env is
   * injected when the process starts and that is the only place it can be right.
   */
  buildEnv?: Record<string, string>;
}

/**
 * Our language names in Railpack's `provider` enum.
 *
 * Only the disagreements are listed; everything else is spelled the same in both.
 * Verified against `railpack schema` at 0.36.3, whose enum is: php, golang, java,
 * rust, ruby, elixir, python, deno, dotnet, node, gleam, cpp, staticfile, shell.
 *
 * A language absent from the enum yields no `provider` at all rather than an
 * invented one — Railpack rejects an unknown provider outright, so guessing turns
 * a build we could not steer into a build that does not start.
 */
const PROVIDER: Record<string, string> = {
  go: "golang",
  static: "staticfile",
};
const PROVIDERS = new Set([
  "php", "golang", "java", "rust", "ruby", "elixir", "python",
  "deno", "dotnet", "node", "gleam", "cpp", "staticfile", "shell",
]);

/**
 * The same language again, spelled mise's way for the `packages` map.
 *
 * This is NOT the provider table and must not be merged with it. `railpack plan
 * examples/goapi` generates `[tools] go = "1.25.0"` while its provider is
 * `golang`; one config file, one language, two names. Ours already match mise's,
 * so this is identity today — it exists to be the place the next disagreement
 * goes, rather than having it discovered in the provider table.
 */
function miseTool(language: string): string {
  return language;
}

/** A version we picked ourselves, as opposed to one the repository stated. */
const OUR_DEFAULT = "platform default";

export function railpackConfig(i: RailpackInput): RailpackConfig {
  const { spec } = i;
  const c: RailpackConfig = {};

  // Only a stated fact overrules Railpack's own detection — see the test that
  // pins this. `certain` means the repository or the user said so in as many
  // words, which is the one thing Railpack cannot read off the directory.
  if (spec.confidence === "certain") {
    const provider = PROVIDER[spec.language] ?? spec.language;
    if (PROVIDERS.has(provider)) c.provider = provider;

    const packages: Record<string, string> = {};
    for (const t of spec.toolchains) {
      if (t.version && t.versionFrom !== OUR_DEFAULT) packages[miseTool(t.language)] = t.version;
    }
    if (Object.keys(packages).length) c.packages = packages;
  }

  if (spec.needs.length) c.buildAptPackages = [...spec.needs];

  c.deploy = { startCommand: spec.command };
  return c;
}

/**
 * The argv tail for `railpack build`.
 *
 * Build-time env goes here rather than into the config file because the schema
 * has nowhere for it: `variables` exists on the deploy step and on named steps,
 * and naming a step would mean guessing at the step layout Railpack chose for
 * this repo. `--env` is the documented way to reach the build regardless of
 * which provider ran.
 */
export function railpackArgs(i: RailpackInput): string[] {
  return Object.entries(i.buildEnv ?? {}).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
}
