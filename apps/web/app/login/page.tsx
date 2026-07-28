"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Zap, Github } from "lucide-react";
import { GoogleIcon } from "@/components/BrandIcons";

/**
 * Only this notice reads the query string, and only this notice sits behind the
 * Suspense boundary Next requires for useSearchParams. Wrapping the whole page
 * instead makes the server render nothing at all — a blank login screen.
 */
function NotInvitedNotice() {
  const params = useSearchParams();
  if (params.get("error") !== "not_invited") return null;
  // Straight from the query string, so cap it and require it to look like an
  // address — otherwise /login?error=not_invited&email=<any sentence> is a
  // ready-made phishing surface in a first-party error box.
  const raw = params.get("email") ?? "";
  const rejected = raw.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw) ? raw : "";
  return (
    <div className="autherr">
      ✕ {rejected || "That address"} isn&apos;t on the invite list. Ask whoever invited you to add it.
    </div>
  );
}

// The URL to return to after auth — read from ?callbackUrl and validated to be a
// supersonic.cv address, so we never bounce a user to an attacker-supplied host.
function safeCallback(): string {
  try {
    const cb = new URLSearchParams(window.location.search).get("callbackUrl");
    if (!cb) return "";
    const u = new URL(cb);
    if (u.protocol === "https:" && (u.hostname === "supersonic.cv" || u.hostname.endsWith(".supersonic.cv"))) return cb;
  } catch { /* malformed — fall through */ }
  return "";
}

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    const res = await signIn("credentials", { email, password, redirect: false });
    setBusy(false);
    if (res?.error) { setErr("Invalid email or password"); return; }
    // Return to the app they were opening (cross-subdomain → full navigation).
    const cb = safeCallback();
    if (cb) { window.location.href = cb; return; }
    router.push("/"); router.refresh();
  }

  return (
    <div className="authpage">
      <div className="authbox">
        <div className="authbrand"><span className="logo"><Zap size={14} strokeWidth={2.4} /></span>SUPERSONIC</div>
        <h1>Sign in</h1>
        <form onSubmit={submit}>
          <input type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          <input type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {err && <div className="autherr">✕ {err}</div>}
          <Suspense fallback={null}><NotInvitedNotice /></Suspense>
          <button className="btn primary" type="submit" disabled={busy}>{busy ? "…" : "Sign in"}</button>
        </form>
        <div className="authoauth">
          <button className="btn" type="button" onClick={() => signIn("google", { callbackUrl: safeCallback() || "/" })}>
            <GoogleIcon />Continue with Google
          </button>
          <button className="btn" type="button" onClick={() => signIn("github", { callbackUrl: safeCallback() || "/" })}>
            <Github size={14} />Continue with GitHub
          </button>
        </div>
        <div className="authalt">No account? <Link href="/signup">Sign up</Link></div>
      </div>
    </div>
  );
}
