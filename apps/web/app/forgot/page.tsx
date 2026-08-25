"use client";

/**
 * "Forgot your password?"
 *
 * The answer is the same whether or not the account exists — see the route for
 * why — so this page has exactly one success state and never reports "no such
 * account". That reads as a bug to whoever typed the wrong address, and it is
 * the only honest thing we can show without handing anybody a membership oracle.
 */
import { useState } from "react";
import Link from "next/link";
import { productName } from "@/lib/brand";

export default function Forgot() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/auth/forgot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      // Read as text first, then parse: a 500 from anywhere in the stack answers
      // with HTML, and `r.json()` on HTML throws a syntax error that surfaces as
      // "couldn't reach the server" about a server that answered.
      const raw = await r.text();
      let d: { error?: unknown } | null = null;
      try { d = JSON.parse(raw) as { error?: unknown }; } catch { d = null; }
      if (r.status === 429) { setErr(typeof d?.error === "string" ? d.error : "too many requests — try again shortly"); return; }
      if (!r.ok) { setErr(typeof d?.error === "string" ? d.error : "something went wrong"); return; }
      setSent(true);
    } catch {
      setErr("couldn't reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="authpage">
      <div className="authbox">
        <div className="flex items-center justify-center gap-2.5 pb-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="" className="size-[26px] shrink-0" height={26} src="/logo-bay.svg" width={26} />
          <span className="text-[17px] font-medium tracking-[-0.03em] text-ink">{productName()}</span>
        </div>

        {sent ? (
          <>
            <h1>Check your email</h1>
            <p className="text-[13.5px] leading-relaxed text-ink-3">
              If <span className="font-medium text-ink-2">{email}</span> has an account, a reset link is on its way. It
              works for one hour.
            </p>
            <div className="authalt">
              <Link href="/login">Back to sign in</Link>
            </div>
          </>
        ) : (
          <>
            <h1>Reset your password</h1>
            <form onSubmit={submit}>
              <input
                autoFocus
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email"
                type="email"
                value={email}
              />
              {err && <div className="autherr">✕ {err}</div>}
              <button className="btn primary" disabled={busy || !email} type="submit">
                {busy ? "…" : "Send reset link"}
              </button>
            </form>
            <div className="authalt">
              Remembered it? <Link href="/login">Sign in</Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
