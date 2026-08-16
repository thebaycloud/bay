/**
 * Where an app is, and where its X-ray is. One place, because these two strings
 * are about to be written in a dozen components and they must not drift.
 *
 * THE MOVE THIS EXISTS FOR
 *
 * An app's control surface used to be a page on the platform:
 * `app.supersonic.cv/apps/<slug>`. It is becoming the app's own address —
 * `<slug>.supersonic.cv/_xray` — which is the whole bet in
 * `docs/research/agent-first-dashboard.md`: one object, two renderings, at the
 * address the owner already knows. The X-ray is reached two ways, over the live
 * app and as the app's own page, and `CONTEXT.md` is explicit that those are
 * "one thing seen from two sides, never two things".
 *
 * Nothing here is a redirect and nothing is deleted. The platform page still
 * exists and still answers, because half of what it does — the app's data, its
 * files, its jobs, its secrets — has not moved yet. This is the seam that lets
 * the halves move one at a time instead of in one commit nobody can review.
 *
 * No `pg`, no server-only imports, nothing that cannot be bundled: these are
 * read from client components.
 */

const ROOT = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "supersonic.cv";

/** The app itself — what an owner shares with somebody. */
export function appUrl(slug: string): string {
  return `https://${slug}.${ROOT}`;
}

/**
 * The app's X-ray, as its own page.
 *
 * A DIFFERENT ORIGIN than the platform, so every link to it has to be a real
 * `<a>` rather than a Next `<Link>` — a client-side route to another host does
 * not navigate, it just does nothing, and the failure is silent.
 *
 * The session cookie is set on `.supersonic.cv` rather than host-only (see
 * docs/CUTOVER.md), so the owner arrives already signed in and the edge
 * recognises them. That is what makes this a link and not a login round-trip.
 */
export function xrayUrl(slug: string): string {
  return `${appUrl(slug)}/_xray`;
}

/**
 * The platform page for an app — the half that has NOT moved.
 *
 * Kept as a named function rather than an inline template so the remaining
 * callers are greppable: when data, files, jobs and secrets reach the X-ray,
 * this is the list of things left to delete.
 */
export function platformAppUrl(slug: string, tab?: string): string {
  return `/apps/${slug}${tab ? `?tab=${tab}` : ""}`;
}
