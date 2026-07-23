export const runtime = "nodejs";

import bcrypt from "bcryptjs";
import { findUserByEmail, createUser } from "@/lib/users";

export async function POST(req: Request) {
  const { email, name, password, invite } = await req.json().catch(() => ({}));
  if (process.env.SIGNUP_INVITE_CODE && String(invite ?? "") !== process.env.SIGNUP_INVITE_CODE) {
    return Response.json({ error: "invalid or missing invite code" }, { status: 403 });
  }
  if (!email || !password) return Response.json({ error: "email and password are required" }, { status: 400 });
  if (String(password).length < 6) return Response.json({ error: "password must be at least 6 characters" }, { status: 400 });
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
