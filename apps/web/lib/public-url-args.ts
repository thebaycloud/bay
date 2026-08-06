/**
 * Telling a frontend its own address, at the only moment it can still hear it.
 *
 * A browser bundle is not configured at runtime. Vite, Next, CRA and every tool
 * like them read `import.meta.env` / `process.env` at BUILD time and write the
 * literal into the JavaScript they ship. Whatever the API URL was when the image
 * was built is what the user's browser will call, forever.
 *
 * So an app built by this platform had no way to learn where it would live. The
 * full-stack FastAPI template ships `frontend/.env` with
 *
 *   VITE_API_URL=http://localhost:8000
 *
 * and `OpenAPI.BASE = import.meta.env.VITE_API_URL ?? ""`. Deployed, its backend
 * answered `/api/v1/utils/health-check/` with 200 on the node — and the signup
 * form in the browser posted to `http://localhost:8000`, got nothing, and showed
 * "Something went wrong". Nothing was broken except the address.
 *
 * That template even declares the way in: `ARG VITE_API_URL=` in its Dockerfile.
 * Nobody passed it.
 *
 * ## Only what the image asks for
 *
 * A build arg that no `ARG` declares is a warning from docker, an error from
 * some builders, and noise in image history from all of them. So this reads the
 * Dockerfile and answers only the names it actually declares.
 *
 * ## Only names that mean "where do I live"
 *
 * `ARG NODE_ENV` and `ARG VITE_SENTRY_DSN` are not addresses. The match is a
 * public-frontend prefix AND a word that means location, which is narrow on
 * purpose: guessing wrong here writes a URL into somebody's bundle where they
 * wanted something else, and they would find out in a browser.
 */

/** Every `ARG` name a Dockerfile declares, in order, deduplicated. */
export function declaredArgs(dockerfile: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of dockerfile.split(/\r?\n/)) {
    // `ARG NAME`, `ARG NAME=default`, `ARG A=1 B=2` — all legal.
    const m = /^\s*ARG\s+(.+)$/i.exec(raw);
    if (!m) continue;
    for (const token of m[1].split(/\s+/)) {
      const name = token.split("=")[0].trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * The prefixes that mean "this value is compiled into the browser bundle".
 *
 * Each tool has its own, and each is a deliberate opt-in by that tool: a
 * variable without the prefix is NOT exposed to the client, which is what makes
 * the prefix a safe signal that the author meant this to be public.
 */
const PUBLIC_PREFIX = /^(VITE_|NEXT_PUBLIC_|REACT_APP_|PUBLIC_|NUXT_PUBLIC_|GATSBY_|EXPO_PUBLIC_)/;

/**
 * The words that mean "an address", after the prefix is stripped.
 *
 * `..._API_URL`, `..._BASE_URL`, `..._BACKEND_URL`, `..._SITE_URL`,
 * `..._APP_URL`, `..._ORIGIN`. Not `..._API_KEY`, not `..._URL_SCHEME`.
 */
const ADDRESS = /(^|_)(API|APP|SITE|BASE|BACKEND|SERVER|PUBLIC)?_?(URL|ORIGIN|BASE)$/;

/** Does this declared name ask for the address the app is served at? */
export function isPublicUrlArg(name: string): boolean {
  if (!PUBLIC_PREFIX.test(name)) return false;
  const rest = name.replace(PUBLIC_PREFIX, "");
  // A bare `VITE_URL` is an address; `VITE_` alone is not a name.
  return rest.length > 0 && ADDRESS.test(rest);
}

/**
 * The build args to pass so a frontend is built knowing where it will live.
 *
 * `url` is the app's own public address. For a repo whose API is a sibling
 * mounted under a path prefix that is still the right answer — the sibling is on
 * the same origin, which is exactly why relative calls work once the base is
 * right.
 *
 * An author who set the value themselves wins: `already` is what
 * `supersonic.json` declared, and this never overwrites it. Somebody who points
 * their frontend at a different API meant it.
 */
export function publicUrlBuildArgs(
  dockerfile: string,
  url: string,
  already: { key: string; value: string }[] = [],
): { key: string; value: string }[] {
  if (!url) return [];
  const declaredAlready = new Set(already.map((a) => a.key));
  return declaredArgs(dockerfile)
    .filter((name) => isPublicUrlArg(name) && !declaredAlready.has(name))
    .map((key) => ({ key, value: url }));
}
