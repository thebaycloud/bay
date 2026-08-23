export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { publicOrigin } from "@/lib/public-origin";

/**
 * The other name GitHub might send somebody back to after installing.
 *
 * An App's *Setup URL* is a field in GitHub's own UI, readable through no API
 * and editable only by an owner of the account that owns the App — there is no
 * REST endpoint for it, `PATCH /app/hook/config` reaches the webhook and
 * nothing else. It carries `https://app.supersonic.cv/api/github/callback`,
 * which is this route and not the `/api/github/setup` the binding lives in, so
 * without this alias every install would finish on a 404.
 *
 * Answering at both names rather than correcting the field, deliberately: the
 * field cannot be read back to check, it cannot be changed by anyone on this
 * side, and a platform whose connect flow depends on a setting nobody here can
 * see is one that breaks again the next time an App is created.
 *
 * A redirect rather than a second copy of the handler: the binding is written
 * in exactly one place, and the query string — `installation_id`,
 * `setup_action`, `state` — is carried across untouched, along with the session
 * cookie the setup route needs and that a same-origin redirect keeps.
 *
 * The origin comes from `publicOrigin` and must never come from `req.url`. That
 * is what shipped, and behind Cloud Run `req.url` is the container's own
 * `http://localhost:8080` — so GitHub delivered people to the right address and
 * this route redirected them off the internet, to a connection-refused page,
 * with a live installation bound to no workspace. See lib/public-origin.ts.
 */
export async function GET(req: Request): Promise<Response> {
  const to = new URL("/api/github/setup", publicOrigin(req));
  to.search = new URL(req.url).search;
  return Response.redirect(to.toString(), 307);
}
