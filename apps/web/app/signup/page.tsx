"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Zap, Github } from "lucide-react";
import { GoogleIcon } from "@/components/BrandIcons";

// A supersonic.cv return URL from ?callbackUrl (validated), so signing up from a
// shared app sends you back to it.
function safeCallback(): string {
  try {
    const cb = new URLSearchParams(window.location.search).get("callbackUrl");
    if (!cb) return "";
    const u = new URL(cb);
    if (u.protocol === "https:" && (u.hostname === "supersonic.cv" || u.hostname.endsWith(".supersonic.cv"))) return cb;
  } catch { /* malformed — fall through */ }
  return "";
}

// Where to land after auth: the CLI hand-off (if `supersonic signup` opened the
// browser with ?port=) wins; then a shared-app callback; otherwise the dashboard.
function oauthCallbackUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const port = params.get("port");
  if (port) {
    const name = params.get("name") || "cli";
    return `/cli?port=${encodeURIComponent(port)}&name=${encodeURIComponent(name)}`;
  }
  return safeCallback() || "/";
}

export default function Signup() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    const r = await (await fetch("/api/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email, password }) })).json();
    if (r.error) { setErr(r.error); setBusy(false); return; }
    const res = await signIn("credentials", { email, password, redirect: false });
    setBusy(false);
    if (res?.error) { setErr("account created — please sign in"); router.push("/login"); return; }
    // If a CLI is waiting (browser was opened by `supersonic signup`), hand off to
    // the authorize page, which mints a token and returns it to the terminal.
    const params = new URLSearchParams(window.location.search);
    const port = params.get("port");
    if (port) {
      const name = params.get("name") || "cli";
      window.location.href = `/cli?port=${encodeURIComponent(port)}&name=${encodeURIComponent(name)}`;
      return;
    }
    // Came from a shared app? Go back to it. Otherwise the dashboard.
    const cb = safeCallback();
    if (cb) { window.location.href = cb; return; }
    router.push("/"); router.refresh();
  }

  return (
    <div className="authpage">
      <div className="authbox">
        <div className="authbrand"><span className="logo"><Zap size={14} strokeWidth={2.4} /></span>SUPERSONIC</div>
        <h1>Create account</h1>
        <form onSubmit={submit}>
          <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <input type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input type="password" placeholder="password (min 6 chars)" value={password} onChange={(e) => setPassword(e.target.value)} />
          {err && <div className="autherr">✕ {err}</div>}
          <button className="btn primary" type="submit" disabled={busy}>{busy ? "…" : "Create account"}</button>
        </form>
        <div className="authoauth">
          <button className="btn" type="button" onClick={() => signIn("google", { callbackUrl: oauthCallbackUrl() })}>
            <GoogleIcon />Continue with Google
          </button>
          <button className="btn" type="button" onClick={() => signIn("github", { callbackUrl: oauthCallbackUrl() })}>
            <Github size={14} />Continue with GitHub
          </button>
        </div>
        <div className="authalt">Have an account? <Link href="/login">Sign in</Link></div>
      </div>
    </div>
  );
}
