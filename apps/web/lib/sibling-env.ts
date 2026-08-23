/**
 * What a sibling service's environment is, given the primary's.
 *
 * A sibling inherits the app's shared environment — the database, the bucket,
 * the user's own secrets — because it is the same app. Three things it must NOT
 * inherit, and each of them is a leak that fails quietly rather than loudly:
 *
 *  1. the primary's CODE pointers,
 *  2. the primary's DEPLOYMENT facts,
 *  3. the primary's DECLARED literals.
 *
 * All three are subtractions, which is why they belong in one pure function with
 * a test each. A filter that stops matching does not throw and does not fail a
 * build; it ships an API that thinks it is a frontend.
 */

/** `KEY=value`, the shape the whole pipeline passes environments around in. */
export type EnvPair = string;

const nameOf = (pair: EnvPair): string => {
  const eq = pair.indexOf("=");
  return eq < 0 ? pair : pair.slice(0, eq);
};

/**
 * The primary's own code pointers, which name a bundle and a command that are
 * not this service's.
 *
 * BOTH spellings, and this one is not cosmetic: CODE_KEY is the key that
 * decrypts the primary's source bundle. Matching only the old prefix while the
 * platform started emitting BAY_CODE_KEY would hand a sibling service the key
 * to another service's code — the exact isolation this filter exists to keep.
 *
 * Written as a prefix pair rather than a rename, because the platform emits
 * both for as long as images older than the rename are still running.
 */
const CODE_POINTER = (pair: EnvPair): boolean =>
  ["BAY_", "SUPERSONIC_"].some((p) => pair.startsWith(`${p}CODE_`) || pair.startsWith(`${p}RUN=`));

export function siblingEnv(o: {
  /** The app's shared environment, computed for the PRIMARY. */
  inherited: readonly EnvPair[];
  /** This service's own `env:` block, already resolved. */
  own: readonly EnvPair[];
  /**
   * The deployment facts for THIS service — its path prefix and whatever its
   * framework needs to know about being mounted under one.
   */
  deployment: Readonly<Record<string, string>>;
  /**
   * The names the PRIMARY declared in its own `env:` block.
   *
   * `env` is per SERVICE in the schema, so the frontend's `NODE_ENV` has no
   * business on the API. Passed as pairs because that is how the primary's are
   * held; only the names are read.
   */
  primaryDeclared: readonly EnvPair[];
}): EnvPair[] {
  const deploymentNames = new Set(Object.keys(o.deployment));
  const declaredNames = new Set(o.primaryDeclared.map(nameOf));

  return [
    ...o.inherited.filter((pair) =>
      !CODE_POINTER(pair)
      // A STALE deployment fact is worse than a missing one, because the app
      // trusts it: a sibling told the primary's SUPERSONIC_PATH_PREFIX builds
      // every URL for a path it is not mounted at, and every link is wrong in a
      // way that looks like the app's own bug. Removed here and restated below
      // from this service's own facts.
      && !deploymentNames.has(nameOf(pair))
      && !declaredNames.has(nameOf(pair))),
    ...o.own,
    ...Object.entries(o.deployment).map(([k, v]) => `${k}=${v}`),
  ];
}
