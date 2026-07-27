import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import bcrypt from "bcryptjs";
import { authConfig } from "./auth.config";
import { findUserByEmail, createUser } from "@/lib/users";
import { resolveWorkspaceForEmail } from "@/lib/workspace";
import { isAllowed, listAllowEntries } from "@/lib/allowlist";
import { getPool } from "@/lib/db";

/* eslint-disable @typescript-eslint/no-explicit-any */
const providers: any[] = [
  Credentials({
    credentials: { email: {}, password: {} },
    async authorize(creds) {
      const email = String(creds?.email ?? "").toLowerCase();
      const password = String(creds?.password ?? "");
      if (!email || !password) return null;
      const user = await findUserByEmail(email);
      if (!user?.password_hash) return null;
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return null;
      return { id: user.id, email: user.email, name: user.name ?? undefined };
    },
  }),
];

// Enabled automatically once creds are set. Config is passed explicitly (rather
// than the bare provider, which would read Auth.js's own AUTH_GOOGLE_ID /
// AUTH_GITHUB_ID names) so the same env vars the conditionals check are the ones
// actually used.
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  providers.push(Google({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  }));
}
if (process.env.GITHUB_ID && process.env.GITHUB_SECRET) {
  providers.push(GitHub({
    clientId: process.env.GITHUB_ID,
    clientSecret: process.env.GITHUB_SECRET,
    // GitHub omits the email from /user when the user keeps it private, which
    // made signIn (which requires user.email) reject every private-email
    // account. Fall back to the primary verified address from /user/emails
    // (the user:email scope, requested by default, authorizes this).
    async profile(profile, tokens) {
      let email = profile.email as string | null;
      if (!email) {
        try {
          const res = await fetch("https://api.github.com/user/emails", {
            headers: { Authorization: `Bearer ${tokens.access_token}`, "User-Agent": "supersonic", Accept: "application/vnd.github+json" },
          });
          if (res.ok) {
            const emails = (await res.json()) as { email: string; primary: boolean; verified: boolean }[];
            email = (emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified) ?? emails[0])?.email ?? null;
          }
        } catch { /* leave email null — signIn will reject with a clear path */ }
      }
      return { id: profile.id.toString(), name: (profile.name ?? profile.login) as string, email, image: profile.avatar_url as string };
    },
  }));
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers,
  callbacks: {
    ...authConfig.callbacks,
    // Runs only on sign-in (when `user` is present). Maps the identity to OUR
    // users.id by verified email and pins it to token.sub, so session.user.id is
    // always our UUID. Without this, OAuth logins carry the provider's account id
    // (Google/GitHub's) as their session id, breaking every ownership + account
    // query. signIn (below) has already upserted the row, so the lookup hits.
    async jwt({ token, user, account }) {
      if (user?.email) {
        const dbUser = await findUserByEmail(user.email);
        console.log(`[jwt-debug] provider=${account?.provider} email=${user.email} userId=${user.id} dbUserId=${dbUser?.id ?? "NULL"} prevSub=${token.sub}`);
        if (dbUser) { token.sub = dbUser.id; token.email = dbUser.email; }
        console.log(`[jwt-debug] finalSub=${token.sub}`);
      }
      return token;
    },
    async signIn({ user, account }) {
      if (!user.email) return false;

      // The gate. It sits in front of every provider, so it protects the
      // password path too until that path is removed.
      let entries;
      try {
        entries = await listAllowEntries();
      } catch (e) {
        // Fail closed. A database blip must not become an authentication bypass.
        console.error("allowlist lookup failed", e);
        return false;
      }
      if (!isAllowed(user.email, entries)) {
        return `/login?error=not_invited&email=${encodeURIComponent(user.email.toLowerCase())}`;
      }

      if (account && account.provider !== "credentials") {
        await createUser(user.email, user.name ?? "", null, account.provider);
      }
      // Only resolve a workspace for a user who doesn't have one yet.
      // resolveWorkspaceForEmail creates a row for personal addresses, so calling
      // it on every sign-in would leave an orphaned workspace behind each time.
      // The row lock serializes concurrent first sign-ins for the same user, which
      // would otherwise both pass the check and both create a workspace.
      const email = user.email.toLowerCase();
      const client = await getPool("supersonic_platform").connect();
      try {
        await client.query("BEGIN");
        const existing = await client.query(
          `SELECT workspace_id FROM users WHERE email = $1 FOR UPDATE`,
          [email]
        );
        if (existing.rows[0] && existing.rows[0].workspace_id === null) {
          const workspaceId = await resolveWorkspaceForEmail(user.email, client);
          await client.query(
            `UPDATE users SET workspace_id = $1 WHERE email = $2 AND workspace_id IS NULL`,
            [workspaceId, email]
          );
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
      return true;
    },
  },
});
