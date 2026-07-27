import type { NextAuthConfig } from "next-auth";

const PROD = process.env.NODE_ENV === "production";

/** ".supersonic.cv" in production; unset locally so cookies stay host-only. */
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined;

export const SESSION_COOKIE_NAME = PROD
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
        p.startsWith("/api/auth") || p.startsWith("/api/signup");
      if (isPublic) return true;
      return !!auth?.user;
    },
    session({ session, token }) {
      if (token.sub && session.user) (session.user as { id?: string }).id = token.sub;
      return session;
    },
    // Allow returning to any *.supersonic.cv host after sign-in, so the proxy
    // can bounce a visitor to /login and get them back to the tool they wanted.
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
