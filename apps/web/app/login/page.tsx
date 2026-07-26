"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Zap, Github } from "lucide-react";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const notInvited = params.get("error") === "not_invited";
  const rejected = params.get("email") ?? "";
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
          {notInvited && (
            <div className="autherr">
              ✕ {rejected || "That address"} isn&apos;t on the invite list. Ask whoever invited you to add it.
            </div>
          )}
          <button className="btn primary" type="submit" disabled={busy}>{busy ? "…" : "Sign in"}</button>
        </form>
        <div className="authoauth">
          <button className="btn" disabled>Continue with Google <span className="soon">soon</span></button>
          <button className="btn" disabled><Github size={14} />Continue with GitHub <span className="soon">soon</span></button>
        </div>
        <div className="authalt">No account? <Link href="/signup">Sign up</Link></div>
      </div>
    </div>
  );
}

// useSearchParams opts the tree into client-side rendering, which Next requires
// to sit behind a Suspense boundary or the /login prerender fails.
export default function Login() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
