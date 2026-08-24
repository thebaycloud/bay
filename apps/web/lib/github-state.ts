/**
 * The one opaque slot GitHub gives us, and the two facts that share it.
 *
 * Its own module because BOTH sides need it and they run in different places:
 * the setup route reads it on the server, and the Ship-new dialog and the
 * settings page write it in the browser. `lib/github-setup.ts` imports
 * `github-app`, which uses `node:crypto` to sign an App JWT — importing it from
 * a client component fails the build with `UnhandledSchemeError: Reading from
 * "node:crypto"`, which is exactly what happened the first time this was wired.
 *
 * GitHub hands an App's install URL a single `state` parameter and gives it back
 * on the setup redirect. That is the only channel: the install happens on
 * github.com, in a flow we do not control, and everything we knew before it is
 * gone by the time they return. So two facts have to share one string.
 *
 * They used to share it by COLLIDING. One reader checked `state` against the
 * literal "apps"; the other validated the same string as a slug. Since "apps" is
 * a valid slug, somebody naming their app `apps` was sent to the app list with
 * their name silently dropped.
 *
 * `~` is the separator because a slug cannot contain one: `[a-z0-9-]` is the
 * whole alphabet, so `apps~my-app` parses in exactly one way and no name can
 * forge a destination.
 *
 * The destination is an ALLOW LIST and never a path from the query string.
 * `state` crosses a third party and comes back; appending it to our own origin is
 * an open redirect, and no amount of validating a path is as safe as not having
 * one. Two keys today — the count is not the property, the closed set is.
 */

const RETURNS = { apps: "/", settings: "/settings" } as const;

export type ReturnKey = keyof typeof RETURNS;
export type ReturnPath = (typeof RETURNS)[ReturnKey];

/** A Cloud Run name, which is the only shape a name may have. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,38}$/;

/** Build the `state` for an install link. */
export function stateFor(to: ReturnKey, name = ""): string {
  return `${to}~${SLUG.test(name) ? name : ""}`;
}

/**
 * Where to send them back to.
 *
 * Defaults to the app list, which is where the Ship-new dialog lives and reopens.
 * That default is not a fallback but the MAIN path for one flow: "Reconfigure"
 * goes to GitHub's own installation settings page, which takes no parameters of
 * ours, so it can never carry a state.
 *
 * `/new` is no longer a destination anything redirects to. It is a page you can
 * still visit, not somewhere the product decides to put you.
 */
export function returnPathFromCallback(url: URL): ReturnPath {
  const raw = (url.searchParams.get("state") ?? "").trim();
  const key = raw.includes("~") ? raw.slice(0, raw.indexOf("~")) : "";
  return (RETURNS as Record<string, ReturnPath>)[key] ?? "/";
}

/**
 * The app name a person had already typed before they were sent to GitHub.
 *
 * Validated as a slug rather than trusted, because it is a string that left our
 * origin and came back through a third party — it lands in a query string on a
 * page we render, and the set of characters that can be in a Cloud Run name is
 * far smaller than the set that can hurt. Anything else answers empty, which
 * means "name it from the repository".
 *
 * Falls back to the whole string when there is no separator, so an install link
 * minted by a version of the page still open in somebody's tab keeps working.
 */
export function nameFromCallback(url: URL): string {
  const raw = (url.searchParams.get("state") ?? "").trim();
  const name = raw.includes("~") ? raw.slice(raw.indexOf("~") + 1) : raw;
  return SLUG.test(name) ? name : "";
}
