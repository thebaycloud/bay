import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import bcrypt from "bcryptjs";
import { authConfig } from "./auth.config";
import { findUserByEmail, createUser } from "@/lib/users";
import { resolveWorkspaceForEmail } from "@/lib/workspace";
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

// Room for the future — enabled automatically once creds are set.
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) providers.push(Google);
if (process.env.GITHUB_ID && process.env.GITHUB_SECRET) providers.push(GitHub);

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers,
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user, account }) {
      if (!user.email) return false;
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
