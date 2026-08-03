import { readObjectText, writeObject } from "./gcp-rest";
import { ASSETS_BUCKET } from "./static-release";

/**
 * What a repair taught us about building this app, kept for the next deploy.
 *
 * THE LOOP THIS BREAKS
 *
 * A repaired Dockerfile lives only in the scratch directory. The scratch
 * directory is a `mkdtemp` that dies with the deploy — so an app the agent
 * rescued by adding `libpq-dev` regenerates the identical Dockerfile next time,
 * fails the identical way, and pays the full repair loop again. Every deploy.
 * The user sees "the agent fixed it" and then watches it be broken again, which
 * is worse than never having fixed it, because it looks like the fix did not work
 * rather than like it was not kept.
 *
 * WHY DECISIONS AND NOT THE FILE
 *
 * Storing the repaired Dockerfile verbatim is the obvious move and it rots. The
 * generator changes — `proxyWait` in CMD, the PATH line, the manifest COPY
 * rewrite, digest pinning — and a stored artifact would pin an app to the
 * template that existed the day it was repaired, silently, forever. That is the
 * same defect as a cache with no TEMPLATE_VERSION, arrived at from the other
 * direction.
 *
 * So what is kept is the smallest thing that cannot go stale: which apt packages
 * this app's build needs. That is exactly what `needs` is, it is what almost
 * every Dockerfile repair actually adds, and it flows back into a freshly
 * generated Dockerfile rather than replacing one.
 *
 * WHERE
 *
 * Beside the app's other build state in the assets bucket, and NOT in Postgres:
 * this has to be readable from the deploy job and writable at the end of a
 * repair, both of which already speak to this bucket, and the no-new-schema rule
 * is in force until deploys work.
 */

export interface BuildHints {
  /** apt packages a previous build was repaired into needing. */
  needs: string[];
  /** ISO timestamp, so a human reading the object can tell how old the advice is. */
  learnedAt: string;
}

const object = (slug: string) => `hints/${slug}.json`;

/** Everything previous repairs of this app concluded. Never throws. */
export async function readBuildHints(slug: string): Promise<BuildHints | null> {
  try {
    const raw = await readObjectText(ASSETS_BUCKET, object(slug));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BuildHints>;
    const needs = Array.isArray(parsed.needs) ? parsed.needs.filter((n) => typeof n === "string") : [];
    return { needs, learnedAt: typeof parsed.learnedAt === "string" ? parsed.learnedAt : "" };
  } catch {
    // A hint that cannot be read is a slower build, never a failed one.
    return null;
  }
}

/** Remember what a repair added. Returns whether anything new was learned. */
export async function rememberBuildHints(slug: string, needs: string[], now = new Date()): Promise<boolean> {
  const existing = await readBuildHints(slug);
  const merged = [...new Set([...(existing?.needs ?? []), ...needs])].sort();
  // Nothing new: do not rewrite the object, so `learnedAt` keeps meaning "when
  // this app last learned something" rather than "when it last deployed".
  if (existing && merged.length === existing.needs.length) return false;
  try {
    await writeObject(ASSETS_BUCKET, object(slug),
      JSON.stringify({ needs: merged, learnedAt: now.toISOString() } satisfies BuildHints, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * The apt packages a Dockerfile installs.
 *
 * Used to read back what the repair agent added, by diffing the file it left
 * against the packages we put there. Deliberately tolerant of how the agent
 * writes the line — ours is one canonical form, and an agent writes whatever a
 * human would.
 *
 * Flags and shell operators are dropped rather than guessed at: `-y`,
 * `--no-install-recommends` and everything after `&&` are not packages, and a
 * hint list containing `&&` would end up on a real apt command line next deploy.
 */
export function aptPackagesIn(dockerfile: string): string[] {
  const found = new Set<string>();
  // Continuations first, so a package list wrapped across lines is one string.
  const flat = dockerfile.replace(/\\\r?\n/g, " ");
  for (const line of flat.split("\n")) {
    // `apt-get` has to be in COMMAND position — start of the instruction, or
    // after a shell operator. Matching it anywhere harvests words out of
    // `RUN echo "apt-get install X"`, and those words would go onto a real apt
    // command line on the next deploy.
    const m = line.match(/(?:^|^RUN\s+|&&\s*|\|\|\s*|;\s*)apt-get\s+(?:-[^\s]+\s+)*install\s+(.*)$/);
    if (!m) continue;
    for (const word of m[1].split(/\s+/)) {
      if (!word || word.startsWith("-")) continue;
      if (word === "&&" || word === "||" || word === ";") break;   // the rest is another command
      if (/^[a-z0-9][a-z0-9+._-]*$/i.test(word)) found.add(word);
    }
  }
  return [...found].sort();
}
