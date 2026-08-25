export const runtime = "nodejs";

/**
 * Spend a reset link and set a new password.
 *
 * The token is redeemed BEFORE the hash is computed, and that ordering is the
 * point: bcrypt at cost 10 is deliberately slow, so hashing first would let
 * anybody burn CPU by posting junk tokens with a long password attached. Same
 * reasoning the signup route spells out for its own ordering.
 */
import bcrypt from "bcryptjs";
import { redeemPasswordReset } from "@/lib/auth-tokens";
import { setPassword } from "@/lib/users";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const token = String(body?.token ?? "");
  const password = String(body?.password ?? "");

  if (!token) return Response.json({ error: "this reset link is not valid" }, { status: 400 });
  // Matches signup's rule. A reset that accepted a weaker password than signup
  // would make the reset flow the way to get one.
  if (password.length < 6) return Response.json({ error: "password must be at least 6 characters" }, { status: 400 });

  try {
    const claim = await redeemPasswordReset(token);
    if (!claim) {
      // One message for expired, already-used and never-existed. Which of the
      // three it was is not information the holder of a bad link is owed, and
      // the actionable advice is identical.
      return Response.json({ error: "this reset link has expired or has already been used" }, { status: 400 });
    }
    const hash = await bcrypt.hash(password, 10);
    await setPassword(claim.userId, hash);
    return Response.json({ ok: true });
  } catch (e) {
    console.error("password-reset:", e instanceof Error ? e.message : String(e));
    return Response.json({ error: "we could not reset your password just now" }, { status: 500 });
  }
}
