export const runtime = "nodejs";

/**
 * "I forgot my password."
 *
 * There was no way back into a password account before this. `credentials-login`
 * and `users.password_hash` are real, and somebody who forgot theirs was locked
 * out permanently — no reset, no support path, nothing.
 *
 * WHY THE ANSWER IS ALWAYS THE SAME
 *
 * This route says "check your email" whether or not the account exists. Telling
 * the truth here turns it into an unlimited membership oracle for any address
 * somebody cares to type — the same reason the signup route rate-limits before
 * its duplicate check rather than after, documented at length over there.
 *
 * It is also always the same for an address that exists as a GOOGLE account with
 * no password. Saying "that's a Google account" is friendlier and leaks exactly
 * the same fact, so the mail explains it instead, where only the person holding
 * the mailbox can read it.
 */
import { findUserByEmailAndProvider } from "@/lib/users";
import { createPasswordReset, RESET_TTL_MIN } from "@/lib/auth-tokens";
import { sendPasswordReset } from "@/lib/emails";
import { takeToken } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";

/**
 * One answer, used on every path out of here.
 *
 * A FUNCTION, not a shared constant: a Response's body is a stream that can be
 * read once, so a module-level instance returned to a second request hands it an
 * already-consumed body.
 */
const same = () =>
  Response.json({ ok: true, message: "If that address has an account, a reset link is on its way." });

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!email) return Response.json({ error: "email is required" }, { status: 400 });

  // Before the lookup, for the enumeration reason above, and because this route
  // sends mail to an address the CALLER chooses — an unbounded one is a way to
  // mail-bomb a stranger from our domain and burn our sending reputation doing
  // it. Two keys: the address, and the caller, which the address key cannot see
  // when somebody walks a list.
  const ip = clientIp(req);
  for (const [scope, key] of [
    ["reset:email", email],
    ["reset:ip", ip],
  ] as const) {
    if (!key) continue;
    const v = await takeToken(scope, key);
    // 429 rather than the uniform answer: a rate limit is about the CALLER, not
    // about whether the account exists, so saying so leaks nothing.
    if (!v.ok) {
      return Response.json(
        { error: "too many reset requests — try again shortly" },
        { status: 429, headers: { "retry-after": String(v.retryAfterSec) } },
      );
    }
  }

  try {
    // Only a credentials account can have its password reset. An OAuth row under
    // the same address is a different account with no password to change.
    const user = await findUserByEmailAndProvider(email, "credentials");
    if (user) {
      const token = await createPasswordReset(user.id);
      await sendPasswordReset({ userId: user.id, email, token, expiresMinutes: RESET_TTL_MIN });
    }
  } catch (e) {
    // Logged, not returned. An error here is either "no such account" shaped or
    // a database problem, and the caller must not be able to tell those apart.
    console.error("forgot-password:", e instanceof Error ? e.message : String(e));
  }
  return same();
}
