/**
 * Who may call an app's API from a browser, and it is exactly one origin.
 *
 * THE ATTACK THIS CLOSES
 *
 * The X-ray drawer is injected into a hosted app and runs on that app's own
 * address, so it calls the control plane cross-origin with `credentials:
 * "include"`. The obvious allowlist — "any *.supersonic.cv" — is the wrong one,
 * and dangerously so, because every one of those origins is SOMEBODY ELSE'S
 * CODE. A hosted app is a tenant's own JavaScript on a supersonic.cv hostname.
 *
 * With a subdomain-wide allowlist, this works:
 *
 *   1. Mallory deploys an app. She now owns and controls `evil.supersonic.cv`.
 *   2. She sends you a link. You open it, signed in, as you are on every one of
 *      our subdomains — the session cookie is set on `.supersonic.cv`.
 *   3. Her page runs fetch('https://app.supersonic.cv/api/apps/YOURAPP/delete',
 *      {method:'POST', credentials:'include'}).
 *   4. The browser attaches YOUR cookie. The route reads YOUR session, sees you
 *      own YOURAPP, and deletes it. Or reads its database. Or writes an env var.
 *
 * Ownership checks do not help: the request IS you. Only the origin
 * distinguishes "the owner acting in their own app" from "a stranger's page
 * acting as the owner", so the origin is what has to be checked.
 *
 * THE RULE
 *
 * A request to `/api/apps/<slug>/…` may come from `https://<slug>.supersonic.cv`
 * and from the control plane itself. Nothing else. An app can therefore reach
 * its OWN API and no other app's, which is exactly the authority its drawer
 * needs and no more. Mallory's page can still call her own app's endpoints —
 * with your session, which does not own her app, so every one of them 403s.
 *
 * Same-origin calls from the dashboard send no `Origin` we need to answer and
 * get no CORS headers, exactly as before.
 */

const ROOT = process.env.ROOT_DOMAIN ?? "supersonic.cv";

/**
 * The headers that permit this request, or an empty object.
 *
 * Empty is a REFUSAL, not an oversight: without
 * `Access-Control-Allow-Origin` the browser discards the response, which is the
 * behaviour we want for an origin that is not this app's own.
 */
export function corsFor(req: Request, slug: string): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  if (!origin) return {}; // same-origin; nothing to allow
  let host: string;
  try {
    const u = new URL(origin);
    // https only. An `http://` origin on our own domain should not exist, and
    // treating one as trusted would accept anything a network attacker injects.
    if (u.protocol !== "https:") return {};
    host = u.hostname;
  } catch {
    return {};
  }

  const allowed = host === `${slug}.${ROOT}` || host === `app.${ROOT}`;
  if (!allowed) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    // Without this a cache can hand the answer for one origin to another. These
    // responses are `no-store` in practice, but the header costs nothing and
    // the day one of them becomes cacheable is not the day to remember it.
    Vary: "Origin",
  };
}

/** The preflight answer. A JSON POST or a DELETE always triggers one. */
export function preflight(req: Request, slug: string): Response {
  return new Response(null, { status: 204, headers: corsFor(req, slug) });
}

type Ctx = { params: { slug: string } };
type Handler = (req: Request, ctx: Ctx) => Promise<Response> | Response;

/**
 * Wrap a route handler so every answer it gives carries the right headers.
 *
 * Wrapped rather than added at each `Response.json` because these routes have
 * between four and eleven return points apiece, and the one that gets missed
 * would be an error path — which is precisely where a caller most needs to read
 * the reply. A header set in one place cannot be forgotten in another.
 *
 * Note this adds headers to the response the handler already decided on: it
 * never changes a status, and it is not an authorisation check. Ownership is
 * still enforced inside each handler, as it was. This only decides whether the
 * BROWSER is allowed to read what came back.
 */
export function withCors(handler: Handler): Handler {
  return async (req, ctx) => {
    const res = await handler(req, ctx);
    const headers = corsFor(req, decodeURIComponent(ctx.params.slug));
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  };
}

/** The OPTIONS export a route needs beside `withCors`. */
export const optionsHandler = (req: Request, ctx: Ctx): Response =>
  preflight(req, decodeURIComponent(ctx.params.slug));
