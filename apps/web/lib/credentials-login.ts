import bcrypt from "bcryptjs";
import { findUserByEmailAndProvider } from "./users";
import { takeToken } from "./rate-limit";
import { clientIp } from "./client-ip";

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
}

/**
 * Signing in with a password, and the only place a password is ever checked.
 *
 * Lifted out of the Credentials provider in auth.ts so that it has a name, a
 * signature and a test. That module exports only what NextAuth returns, which
 * left this closure unreachable from anywhere — and a brute-force gate nobody
 * can test is a gate nobody can prove still works after the next edit. It was
 * moved before it was guarded, deliberately in that order.
 *
 * `request` is optional because the signature belongs to next-auth, which
 * passes it (5.0.0-beta.32; `@auth/core/providers/credentials.d.ts` documents
 * the second argument as "you have access to the original request as well").
 * Checked against the installed types rather than assumed, because without it
 * there is no address and the limiter below has nothing to key on.
 */
export async function authorizeCredentials(
  creds: unknown,
  request?: Request,
): Promise<SessionUser | null> {
  const c = creds as { email?: unknown; password?: unknown } | undefined;
  // Folded here, before it becomes part of a bucket key. Otherwise a guesser
  // gets a fresh ceiling for every capitalisation of one address, which is an
  // unbounded supply of them.
  const email = String(c?.email ?? "").toLowerCase();
  const password = String(c?.password ?? "");
  // An empty submit is a slip, not an attempt, and it is refused before any
  // token is spent: counting it would let a stuck form burn somebody's own
  // ceiling and lock them out of their own account.
  if (!email || !password) return null;

  // FAILS CLOSED, unlike every other limiter call in this codebase. A database
  // outage must not be the thing that opens a brute-force window. The switch
  // lives on the scope in lib/rate-limit.ts, beside the number, rather than
  // here — same asymmetry takeFreeFix already makes, and for the same reason:
  // being wrong open on signup costs a few junk accounts, being wrong open here
  // costs somebody's account.
  //
  // Keyed on email AND address. Email alone would let anybody lock a victim out
  // of their own account from anywhere, which turns the protection into the
  // attack. Address alone would let one office behind a NAT exhaust the ceiling
  // for everyone sharing it. The pair is the smallest key that is neither.
  //
  // The gate runs before the user lookup as well as before the hash. A
  // throttled attempt that still queried could be timed against a known-good
  // address, which is a slower way of asking the question the gate is refusing.
  const ip = request ? clientIp(request) : null;
  if (ip) {
    const v = await takeToken("login:email-ip", `${email}|${ip}`);
    // Null, exactly as a wrong password returns null. This function has no
    // other vocabulary, and that is convenient rather than limiting: telling an
    // attacker the difference between "wrong" and "throttled" tells them the
    // address exists, which is the fact the guessing was for. The Retry-After
    // is deliberately spent.
    if (!v.ok) return null;
  }

  // Only the password account for this email — never an OAuth account that
  // happens to share it (those have no password_hash anyway).
  const user = await findUserByEmailAndProvider(email, "credentials");
  if (!user?.password_hash) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;
  return { id: user.id, email: user.email, name: user.name ?? undefined };
}
