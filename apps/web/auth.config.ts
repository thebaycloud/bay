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
