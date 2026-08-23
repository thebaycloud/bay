export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The other name GitHub might send somebody back to after installing.
 *
 * An App's *Setup URL* is a field in GitHub's own UI, readable through no API
 * and editable only by an owner of the account that owns the App. Ours was
 * written before the route was named, and points here — at `/api/github/callback`,
 * which the shipped code calls `/api/github/setup`. The result is a person who
 * finishes installing and lands on a 404 with an installation that exists and is
 * bound to nothing.
 *
 * Fixed here rather than in that field, deliberately. The field cannot be read
 * back to check, it cannot be changed by anyone on this side, and a platform
 * whose connect flow depends on a setting nobody here can see is one that breaks
 * again the next time an App is created. Answering at both names costs three
 * lines and removes the dependency.
 *
 * A redirect rather than a second copy of the handler: the binding is written in
 * exactly one place, and the query string — `installation_id`, `setup_action` —
 * is carried across untouched, along with the session cookie the setup route
 * needs and that a same-origin redirect keeps.
 */
export async function GET(req: Request): Promise<Response> {
  const from = new URL(req.url);
  const to = new URL("/api/github/setup", from.origin);
  to.search = from.search;
  return Response.redirect(to.toString(), 307);
}
