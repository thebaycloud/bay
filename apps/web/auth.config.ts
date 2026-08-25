import type { NextAuthConfig } from "next-auth";

const PROD = process.env.NODE_ENV === "production";

/**
 * ".<canonical root>" in production; unset locally so cookies stay host-only.
 *
 * ONE root, and it must be the canonical one. A cookie belongs to a single
 * domain — there is no form of it that covers both supersonic.cv and
 * thebay.cloud — so during the cutover this moves to the new root and everybody
 * signs in once more. That is also why `platformUrl` in the proxy sends a
 * visitor to the canonical root and not to whichever one they arrived on: the
 * sign-in gate has to be shown where the cookie can be set.
 *
 * Changing this and `ROOT_DOMAINS` in the same deploy is the cutover. Changing
 * one without the other is a sign-in loop.
 */
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined;

const SESSION_COOKIE_NAME = PROD
  ? "__Secure-authjs.session-token"
  : "authjs.session-token";

// Edge-safe config (no Node-only imports) — used by middleware.
export const authConfig = {
  pages: { signIn: "/login" },
  session: { strategy: "jwt" },
  trustHost: true,
  providers: [],
  cookies: {
    sessionToken: {
      name: SESSION_COOKIE_NAME,
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: PROD,
        domain: COOKIE_DOMAIN,
      },
    },
  },
  callbacks: {
    authorized({ auth, request }) {
      const p = request.nextUrl.pathname;
      // CORS preflight carries no credentials and has no side effects — let the
      // route's own OPTIONS handler answer it instead of redirecting to login.
      if (request.method === "OPTIONS") return true;
      // API calls carrying a CLI Bearer token bypass the cookie gate — the
      // route itself validates the token (edge middleware can't reach Postgres).
      const hasBearer = /^bearer\s+/i.test(request.headers.get("authorization") ?? "");
      if (p.startsWith("/api/") && hasBearer) return true;
      const isPublic =
        p.startsWith("/login") || p.startsWith("/signup") ||
        p.startsWith("/api/auth") || p.startsWith("/api/signup") ||
        // Password recovery, and it has to be here for the obvious reason: the
        // person who needs it is by definition unable to sign in. Left off this
        // list, /forgot 307s to /login — which is the page they just failed at —
        // and the only route back into an account is a loop. Verified against
        // production before it was fixed.
        p.startsWith("/forgot") || p.startsWith("/reset") ||
        // The confirmation link, clicked from a mail client that has no session
        // and cannot get one. The token IS the credential here; it proves control
        // of the mailbox, which is the whole point, so it needs no cookie.
        p.startsWith("/verify") ||
        // The error sweep, called by a scheduler with no cookie and never by a
        // person — it authenticates itself with a shared secret in constant time,
        // and answers 404 without one. Behind the cookie gate it would 307 and
        // the sweep would simply never run: no error, no warning, no mail, which
        // is the same silent failure this file already records for woff2 and
        // /film.
        p.startsWith("/api/internal/") ||
        // The design-block gallery. It renders no user data, but it is a
        // working surface rather than a product one, so it is reachable only
        // off production — in prod it stays behind the cookie gate like
        // everything else.
        (!PROD && (p.startsWith("/design") || p.startsWith("/landing"))) ||
        // Stripe calls this server-to-server with no cookie; it verifies its own
        // signature. The rest of /api/billing stays behind the cookie gate.
        p.startsWith("/api/billing/webhook") ||
        // GitHub, for the same reason and on the same terms: no cookie exists to
        // send, and the route verifies an HMAC over the raw body before it
        // touches anything. The rest of /api/github stays behind the gate —
        // those routes answer a person, and a person has a session.
        p.startsWith("/api/github/webhook");
      if (isPublic) return true;
      return !!auth?.user;
    },
    session({ session, token }) {
      if (token.sub && session.user) (session.user as { id?: string }).id = token.sub;
      return session;
    },
    // Allow returning to any host under the cookie's own root after sign-in, so
    // the proxy can bounce a visitor to /login and get them back to the tool
    // they wanted. Only that root: a return to a host the cookie does not cover
    // would land them signed out at the address they started from.
    redirect({ url, baseUrl }) {
      try {
        const target = new URL(url, baseUrl);
        if (target.protocol !== "https:" && target.protocol !== "http:") return baseUrl;
        if (!COOKIE_DOMAIN) return target.origin === new URL(baseUrl).origin ? target.toString() : baseUrl;
        const root = COOKIE_DOMAIN.replace(/^\./, "");
        if (target.hostname === root || target.hostname.endsWith("." + root)) return target.toString();
      } catch { /* fall through */ }
      return baseUrl;
    },
  },
} satisfies NextAuthConfig;
