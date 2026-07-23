"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Zap } from "lucide-react";

export default function Signup() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    const r = await (await fetch("/api/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email, password, invite }) })).json();
    if (r.error) { setErr(r.error); setBusy(false); return; }
    const res = await signIn("credentials", { email, password, redirect: false });
    setBusy(false);
    if (res?.error) { setErr("account created — please sign in"); router.push("/login"); return; }
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
          <input placeholder="invite code" value={invite} onChange={(e) => setInvite(e.target.value)} />
          {err && <div className="autherr">✕ {err}</div>}
          <button className="btn primary" type="submit" disabled={busy}>{busy ? "…" : "Create account"}</button>
        </form>
        <div className="authalt">Have an account? <Link href="/login">Sign in</Link></div>
      </div>
    </div>
  );
}
