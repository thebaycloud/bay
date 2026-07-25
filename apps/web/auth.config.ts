import type { NextAuthConfig } from "next-auth";

// Edge-safe config (no Node-only imports) — used by middleware.
export const authConfig = {
  pages: { signIn: "/login" },
  session: { strategy: "jwt" },
  trustHost: true,
  providers: [],
  callbacks: {
    authorized({ auth, request }) {
      const p = request.nextUrl.pathname;
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
  },
} satisfies NextAuthConfig;
