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
