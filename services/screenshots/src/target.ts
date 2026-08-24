/**
 * Working out what to point the browser at, and what to send with it.
 *
 * Apps are sealed: only the proxy may invoke them, and the proxy only forwards for
 * a signed-in visitor. A screenshotter has no session, so it goes straight to the
 * app's own Cloud Run URL with an ID token, exactly as the deploy probe already
 * does — same door, same key.
 *
 * Static apps complicate it. They have no service of their own; one shared server
 * fronts all of them and works out which app a request is for from a header the
 * proxy sets. Going direct means setting that header ourselves.
 */

const ALLOWED_SUFFIXES = [".run.app", ".thebay.cloud", ".supersonic.cv"] as const;

const STATIC_HOST_RE = /^https:\/\/supersonic-static[-.]/;

export interface Target {
  /** Where the browser navigates. */
  url: string;
  /** Headers the navigation must carry. */
  headers: Record<string, string>;
  /** Which app this is, for the storage key. */
  slug: string;
}

const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function isStaticUpstream(runUrl: string): boolean {
  return STATIC_HOST_RE.test(runUrl);
}

/**
 * Build the navigation target.
 *
 * Returns null rather than guessing when the slug is malformed or the URL is not
 * one of ours — this runs on input that ultimately came from a database row, and a
 * screenshotter that will navigate anywhere is an SSRF primitive with a browser
 * attached.
 */
export function buildTarget(slug: string, runUrl: string, idToken: string | null): Target | null {
  if (!SLUG.test(slug)) return null;
  let parsed: URL;
  try {
    parsed = new URL(runUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  // The allow-list, and it has to name every root the platform serves. This is
  // an SSRF guard: a hostname that is not on it is refused outright. Missing the
  // new root would not fail loudly — it would simply stop taking screenshots of
  // every app on it, and read as the screenshot service being broken.
  if (!ALLOWED_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix))) return null;

  const headers: Record<string, string> = {};
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  // The shared static server cannot tell which app a request is for without this;
  // the hostname it sees is its own.
  if (isStaticUpstream(runUrl)) headers["x-supersonic-slug"] = slug;

  return { url: parsed.origin, headers, slug };
}

/** Where the image lands. One per app, overwritten on each deploy. */
export function objectPath(slug: string): string {
  return `_thumbs/${slug}.jpg`;
}
