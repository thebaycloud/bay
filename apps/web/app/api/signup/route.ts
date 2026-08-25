export const runtime = "nodejs";

import bcrypt from "bcryptjs";
import { findUserByEmailAndProvider, createUser } from "@/lib/users";
import { takeToken } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { sendWelcome, sendVerifyEmail } from "@/lib/emails";
import { createEmailVerification } from "@/lib/auth-tokens";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { name, password } = body;
  // isAllowed trims, but findUserByEmail/createUser only lowercase — an
  // untrimmed address would pass the gate and create a row nobody can log into.
  const email = String(body.email ?? "").trim();
  if (!email || !password) return Response.json({ error: "email and password are required" }, { status: 400 });
  if (String(password).length < 6) return Response.json({ error: "password must be at least 6 characters" }, { status: 400 });

  // Before bcrypt, and before the duplicate check, and both of those orderings
  // are the point rather than an accident.
  //
  // Before bcrypt because a hash at cost 10 is deliberately slow: an unlimited
  // signup route burns CPU on every attempt whether or not an account is ever
  // created, which makes it a denial-of-service surface quite separately from
  // being an account farm.
  //
  // Before the duplicate check because answering "an account with that email
  // already exists" first turns this route into an unlimited oracle for which
  // addresses are registered. Slower than a leaked table, and just as complete.
  //
  // Two keys, because they catch different things. The address catches one
  // machine making accounts in a loop. The email domain catches the farm that
  // rotates addresses but keeps one throwaway domain, which the address key
  // misses entirely — and it is set higher, because a real company signing its
  // team up in one afternoon shares a domain and must not read as a farm.
  //
  // A missing address is not a shared bucket. `clientIp` returns null when
  // there is no forwarded header, and one bucket holding every such request
  // would let a handful of them lock out all the rest; the key is skipped
  // instead and the domain key does the work alone.
  const ip = clientIp(req);
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  for (const [scope, key] of [
    ["signup:ip", ip],
    ["signup:email-domain", domain],
  ] as const) {
    if (!key) continue;
    const v = await takeToken(scope, key);
    if (!v.ok) {
      return Response.json(
        { error: "too many signups from here — try again shortly" },
        { status: 429, headers: { "retry-after": String(v.retryAfterSec) } },
      );
    }
  }

  try {
    // Only a password account for this email blocks signup — an OAuth account
    // under the same email is a separate account and doesn't conflict.
    if (await findUserByEmailAndProvider(String(email), "credentials")) {
      return Response.json({ error: "an account with that email already exists" }, { status: 400 });
    }
    const hash = await bcrypt.hash(String(password), 10);
    const user = await createUser(String(email), String(name || ""), hash, "credentials");

    // AWAITED, which on this runtime is not the obvious choice and is the right
    // one. Cloud Run throttles an instance's CPU once the response is sent, so
    // work started and not awaited may simply never run — a fire-and-forget send
    // here would deliver in development and silently do nothing in production,
    // which is the worst available outcome for a welcome email.
    //
    // Safe to await because the provider call is bounded (see SEND_TIMEOUT_MS)
    // and `send()` never throws: the account is already created, and a mail
    // failure lands in the ledger rather than in this response.
    try {
      await sendWelcome({ userId: user.id, email: String(email), name: String(name || "") });
      const token = await createEmailVerification(user.id, String(email));
      await sendVerifyEmail({ userId: user.id, email: String(email), token });
    } catch (e) {
      // Belt and braces: a signup must not fail because mail did.
      console.error("signup mail:", e instanceof Error ? e.message : String(e));
    }

    return Response.json({ ok: true, id: user.id });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
