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
 * The `.env` filenames worth reading, in the order a bundler itself would.
 *
 * `.env.example` earns its place by being the one that is usually COMMITTED —
 * `.env` and `.env.local` are gitignored in most templates, so on a git-cloned
 * deploy the example file is often the only evidence left of which names the app
 * wants. It is also the safest to read: it exists to be read.
 *
 * `.env.production` is included because a bundler prefers it in a production
 * build, so a name declared only there is still a name this app asks for.
 */
export const ENV_FILENAMES = [".env", ".env.example", ".env.production", ".env.local"];

/**
 * Every name an app's own `.env` declares, in order, deduplicated.
 *
 * WHY A SECOND SOURCE. `declaredArgs` reads a Dockerfile, and the Railpack lane
 * has none — a build plan declares no `ARG`, so on that lane the Dockerfile
 * route silently finds nothing and a frontend ships pointing at localhost.
 *
 * The `.env` is not a fallback so much as the better source that was there all
 * along: the case in this module's header is the FastAPI template shipping
 * `frontend/.env` with `VITE_API_URL=http://localhost:8000`. The name was
 * visible in two places and we were reading the other one.
 *
 * Parsing is deliberately shallow — names only, values ignored. This never needs
 * to know what a value IS, only that the app asked for the name, and a real
 * dotenv parser brings interpolation, multi-line quoting and `${VAR}` expansion
 * for no gain here.
 */
export function declaredEnvNames(envFile: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of envFile.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // `NAME=`, `export NAME=` — both ordinary. A line with no `=` declares
    // nothing, whatever else it may be.
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push(m[1]);
  }
  return out;
}

/**
 * The same answer as `publicUrlBuildArgs`, learned from `.env` files instead.
 *
 * THE VALUE IN THE FILE IS REPLACED, and that is the whole point rather than an
 * oversight. A committed `.env` holds a DEVELOPMENT default — it says localhost
 * because localhost is where the author was — and shipping it unchanged is
 * precisely the failure this module exists to prevent.
 *
 * `already` still wins, exactly as on the Dockerfile route, and the distinction
 * is worth stating: a `.env` is where someone developed; `supersonic.json`
 * `buildEnv` is what they said about DEPLOYING. Someone pointing their frontend
 * at a different API in the second one meant it.
 */
export function publicUrlEnvArgs(
  envFiles: string[],
  url: string,
  already: { key: string; value: string }[] = [],
): { key: string; value: string }[] {
  if (!url) return [];
  const declaredAlready = new Set(already.map((a) => a.key));
  const seen = new Set<string>();
  const out: { key: string; value: string }[] = [];
  for (const file of envFiles) {
    for (const name of declaredEnvNames(file)) {
      if (!isPublicUrlArg(name) || declaredAlready.has(name) || seen.has(name)) continue;
      seen.add(name);
      out.push({ key: name, value: url });
    }
  }
  return out;
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
