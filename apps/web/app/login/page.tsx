"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Github } from "lucide-react";
import { Mark } from "@/components/Mark";
import { isPlatformHost } from "@/lib/roots";
import { GoogleIcon } from "@/components/BrandIcons";

// The URL to return to after auth — read from ?callbackUrl and validated to be a
// host under one of our own roots, so we never bounce a user to an
// attacker-supplied one. Asked of `rootDomains()` rather than a literal: during
// the cutover both roots answer, and a literal here would refuse the new one.
//
// A same-origin path is allowed too (leading "/" but not "//", which the browser
// reads as a protocol-relative host): that is how /cli sends you back to the
// authorization it was in the middle of after you switch accounts, and it is the
// only form that survives local development, where there is no public root.
function safeCallback(): string {
  try {
    const cb = new URLSearchParams(window.location.search).get("callbackUrl");
    if (!cb) return "";
    if (cb.startsWith("/") && !cb.startsWith("//")) return cb;
    const u = new URL(cb);
    if (u.protocol === "https:" && isPlatformHost(u.hostname)) return cb;
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
        <div className="authbrand"><span className="logo"><Mark size={15} onDark /></span>SUPERSONIC</div>
        <h1>Sign in</h1>
        <form onSubmit={submit}>
          <input type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          <input type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {err && <div className="autherr">✕ {err}</div>}
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
