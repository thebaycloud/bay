export const runtime = "nodejs";

import bcrypt from "bcryptjs";
import { findUserByEmail, createUser } from "@/lib/users";
import { isAllowed, listAllowEntries } from "@/lib/allowlist";

export async function POST(req: Request) {
  const { email, name, password, invite } = await req.json().catch(() => ({}));
  if (process.env.SIGNUP_INVITE_CODE && String(invite ?? "") !== process.env.SIGNUP_INVITE_CODE) {
    return Response.json({ error: "invalid or missing invite code" }, { status: 403 });
  }
  if (!email || !password) return Response.json({ error: "email and password are required" }, { status: 400 });
  if (String(password).length < 6) return Response.json({ error: "password must be at least 6 characters" }, { status: 400 });

  // Without this, signup happily creates an account the sign-in gate will then
  // refuse forever — the row exists, the person can never get in, and the
  // allowlist seed (taken at migration time) never learns about them.
  // Fails closed for the same reason the gate does.
  try {
    if (!isAllowed(String(email), await listAllowEntries())) {
      return Response.json({ error: "that address isn't on the invite list" }, { status: 403 });
    }
  } catch (e) {
    console.error("allowlist lookup failed", e);
    return Response.json({ error: "could not verify the invite list" }, { status: 503 });
  }
  try {
    if (await findUserByEmail(String(email))) {
      return Response.json({ error: "an account with that email already exists" }, { status: 400 });
    }
    const hash = await bcrypt.hash(String(password), 10);
    const user = await createUser(String(email), String(name || ""), hash, "credentials");
    return Response.json({ ok: true, id: user.id });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
