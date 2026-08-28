"use client";

/**
 * Choose a new password.
 *
 * The token is read from the query string and never shown. On success this signs
 * the user straight in rather than sending them to /login to type the password
 * they just chose — they have already proved they hold the mailbox, and a second
 * form is friction with nothing behind it.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { productName } from "@/lib/brand";

export default function Reset() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // No token at all is its own state: it means a truncated link, and the useful
  // thing to say is "ask for a new one" rather than a validation error under an
  // empty form.
  if (!token) {
    return (
      <div className="authpage">
        <div className="authbox">
          <h1>This link is incomplete</h1>
          <p className="text-[13.5px] leading-relaxed text-ink-3">
            Some mail clients cut long links. Ask for a fresh one and open it from the email directly.
          </p>
          <div className="authalt"><Link href="/forgot">Send a new link</Link></div>
        </div>
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setErr("those don't match"); return; }
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/auth/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const raw = await r.text();
      let d: { error?: unknown } | null = null;
      try { d = JSON.parse(raw) as { error?: unknown }; } catch { d = null; }
      if (!r.ok) { setErr(typeof d?.error === "string" ? d.error : "something went wrong"); return; }
      // Straight in. `signIn` needs the address, which we do not have here — the
      // token carried the identity, not the form — so this goes to /login with
      // the password already set, and a note saying so.
      router.push("/login?reset=1");
      router.refresh();
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
        <h1>Choose a new password</h1>
        <form onSubmit={submit}>
          <input
            autoFocus
            onChange={(e) => setPassword(e.target.value)}
            placeholder="new password"
            type="password"
            value={password}
          />
          <input
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="confirm password"
            type="password"
            value={confirm}
          />
          {err && <div className="autherr">✕ {err}</div>}
          <button className="btn primary" disabled={busy || password.length < 6} type="submit">
            {busy ? "…" : "Set password"}
          </button>
        </form>
        <div className="authalt">At least 6 characters.</div>
      </div>
    </div>
  );
}
