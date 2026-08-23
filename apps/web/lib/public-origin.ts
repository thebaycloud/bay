/**
 * The origin a browser can actually come back to.
 *
 * `new URL(req.url).origin` is the obvious thing and it is wrong here. Behind
 * Cloud Run the container listens on 8080 and Next builds `req.url` from that,
 * so the origin reads `http://localhost:8080` — a real URL, on a host that
 * exists only inside the container. Put it in a `Location` header and the
 * person's browser follows it off the internet: it cost one whole install flow,
 * where GitHub delivered somebody to the right address and we redirected them
 * to a connection-refused page with a live installation bound to nothing.
 *
 * It fails in exactly the shape that hides it, too. Every test, and every run
 * of `next dev`, IS on localhost — so the wrong answer is the right one
 * everywhere except production.
 *
 * ## Why the environment wins over the headers
 *
 * `x-forwarded-host` is set by our proxy and by anybody else who feels like it;
 * nothing about the header says which. Trusting it first would mean a request
 * carrying `x-forwarded-host: evil.example` gets a redirect to
 * `https://evil.example/new` — our own open redirect, handed out to a person
 * who is mid-way through connecting their source code.
 *
 * `APP_URL` is set from the service definition, is not attacker-reachable, and
 * is already how the rest of this codebase names itself (see `lib/stripe.ts`,
 * `app/layout.tsx`). So it is asked first and, in production, is the only
 * answer. The header is a fallback for a deployment that forgot to set it, and
 * `req.url` is the last resort that keeps `next dev` working.
 */

/** The first value of a possibly comma-joined forwarding header. */
function first(v: string | null): string {
  return (v ?? "").split(",")[0]!.trim();
}

export function publicOrigin(req: Request): string {
  const configured = (process.env.APP_URL ?? "").trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // A malformed APP_URL must not take the whole redirect down with it —
      // fall through to the headers, which are usually right.
    }
  }

  const host = first(req.headers.get("x-forwarded-host")) || first(req.headers.get("host"));
  if (host) {
    // Default to https rather than to the request's own scheme: the hop we
    // terminate is plain http inside the container, so echoing it back would
    // downgrade every redirect in production.
    const proto = first(req.headers.get("x-forwarded-proto")) || "https";
    try {
      return new URL(`${proto}://${host}`).origin;
    } catch {
      // A host header we cannot parse is a host we must not put in a Location.
    }
  }

  return new URL(req.url).origin;
}
