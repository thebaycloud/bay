import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import { authConfig } from "./auth.config";
import { findUserByEmailAndProvider, createUser, markEmailVerified } from "@/lib/users";
import { authorizeCredentials } from "@/lib/credentials-login";
import { resolveWorkspaceForEmail } from "@/lib/workspace";
import { getPool } from "@/lib/db";

/* eslint-disable @typescript-eslint/no-explicit-any */
const providers: any[] = [
  Credentials({
    credentials: { email: {}, password: {} },
    // The logic lives in lib/credentials-login.ts, and the move was not
    // tidying. This module exports only what NextAuth hands back, so a closure
    // written here is unreachable from a test — which was survivable while it
    // only compared a hash, and is not now that it also carries the
    // brute-force gate. A protection nobody can test is a protection nobody can
    // prove still works after the next edit to the file.
    authorize: (creds, request) => authorizeCredentials(creds, request as Request),
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
    // The default profile drops `email_verified`, and a domain rule needs it:
    // "anyone at acme.com" may only admit somebody Google says holds that
    // address. Google sets it false for an unverified alias on a consumer
    // account, so it is read rather than assumed.
    profile(profile) {
      return {
        id: profile.sub,
        name: profile.name,
        email: profile.email,
        image: profile.picture,
        emailVerified: profile.email_verified === true,
      };
    },
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
      // GitHub only publishes an address on /user that the account has verified,
      // so a public one is proof; the /user/emails path below decides for itself.
      let verified = !!email;
      if (!email) {
        try {
          const res = await fetch("https://api.github.com/user/emails", {
            headers: { Authorization: `Bearer ${tokens.access_token}`, "User-Agent": "supersonic", Accept: "application/vnd.github+json" },
          });
          if (res.ok) {
            const emails = (await res.json()) as { email: string; primary: boolean; verified: boolean }[];
            const proven = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
            // The unverified fallback still signs the person in — it is their
            // account either way — but it is NOT evidence of the domain, so it
            // is remembered as unverified and no domain rule will admit it.
            email = (proven ?? emails[0])?.email ?? null;
            verified = !!proven;
          }
        } catch { /* leave email null — signIn will reject with a clear path */ }
      }
      return { id: profile.id.toString(), name: (profile.name ?? profile.login) as string, email, image: profile.avatar_url as string, emailVerified: verified };
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
        // Resolve to the (email, provider) account, so each provider is its own
        // account and token.sub is our users.id — not the OAuth account id.
        const dbUser = await findUserByEmailAndProvider(user.email, account?.provider ?? "credentials");
        if (dbUser) { token.sub = dbUser.id; token.email = dbUser.email; }
      }
      return token;
    },
    async signIn({ user, account }) {
      if (!user.email) return false;

      // No invite gate. Sign-in used to be checked against `allowed_signins`,
      // failing closed so a database blip could not become an auth bypass. The
      // product is public now, so the gate is gone rather than left as a table
      // somebody has to remember to add a row to. `lib/admin.ts` still uses
      // isAllowed over its OWN table — that one grants operator access, not
      // sign-in, and is unaffected.

      if (account && account.provider !== "credentials") {
        await createUser(user.email, user.name ?? "", null, account.provider, user.image ?? null);
        // Whether the provider PROVED this address, recorded on the row because
        // the edge reads it long after this request: a domain rule ("anyone at
        // acme.com") may only admit a proven address. Signup with a password
        // proves nothing, so those rows stay false and are admitted by name
        // only — which is safe, because there the owner typed the address.
        //
        // Only ever raised, never lowered. GitHub can answer "verified" once and
        // fall back to an unverified address later; the proof already happened.
        if ((user as { emailVerified?: boolean }).emailVerified) {
          await markEmailVerified(user.email, account.provider);
        }
      }
      // Only resolve a workspace for a user who doesn't have one yet.
      // resolveWorkspaceForEmail creates a row for personal addresses, so calling
      // it on every sign-in would leave an orphaned workspace behind each time.
      // The row lock serializes concurrent first sign-ins for the same user, which
      // would otherwise both pass the check and both create a workspace.
      // Scope to THIS account (email + provider) — a shared email now spans
      // several accounts, and each gets its own workspace so their apps stay
      // separate.
      const email = user.email.toLowerCase();
      const provider = account?.provider ?? "credentials";
      const client = await getPool("supersonic_platform").connect();
      try {
        await client.query("BEGIN");
        const existing = await client.query(
          `SELECT workspace_id FROM users WHERE email = $1 AND provider = $2 FOR UPDATE`,
          [email, provider]
        );
        if (existing.rows[0] && existing.rows[0].workspace_id === null) {
          const workspaceId = await resolveWorkspaceForEmail(user.email, client);
          await client.query(
            `UPDATE users SET workspace_id = $1 WHERE email = $2 AND provider = $3 AND workspace_id IS NULL`,
            [workspaceId, email, provider]
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
