import { headers } from "next/headers";
import { auth } from "@/auth";
import { findUserByToken } from "./cli-tokens";

// Resolve the caller either from a CLI Bearer token (the coding-agent path) or
// the Auth.js session cookie (the browser path). Bearer wins when present.
export async function currentUserId(): Promise<string | null> {
  const authz = headers().get("authorization");
  if (authz && /^bearer\s+/i.test(authz)) {
    const uid = await findUserByToken(authz.replace(/^bearer\s+/i, "").trim());
    if (uid) return uid;
  }
  const s = await auth();
  return (s?.user as { id?: string } | undefined)?.id ?? null;
}

/**
 * The caller, from the session cookie ONLY.
 *
 * `currentUserId` above accepts a CLI Bearer token, which is right for almost
 * everything: a coding agent shipping an app is the point of the product. It is
 * wrong for a route that CHANGES somebody's data.
 *
 * A CLI token is a long-lived string that lives in a file on a developer's
 * machine and gets handed to agents. Every read it can reach is recoverable —
 * worst case somebody learns a row they already had access to. A write is not:
 * an UPDATE against a production table cannot be undone by revoking the token
 * afterwards, and per-app backups do not exist yet to undo it with.
 *
 * So the row editor takes a browser session and nothing else. A person, in a
 * tab, who clicked the cell. See app/api/apps/[slug]/db/row/route.ts.
 */
export async function sessionUserId(): Promise<string | null> {
  const s = await auth();
  return (s?.user as { id?: string } | undefined)?.id ?? null;
}
