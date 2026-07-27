"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { Zap, LayoutGrid, Settings, LogOut, Sparkles } from "lucide-react";

interface Acct { email: string; name: string | null; plan: "basic" | "pro"; }

// Persistent left rail: brand, nav, and the account block pinned to the bottom.
export function Sidebar({ active }: { active?: "apps" | "settings" }) {
  const [acct, setAcct] = useState<Acct | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/account").then((r) => (r.ok ? r.json() : null)).then((d) => { if (d?.email) setAcct(d); }).catch(() => {});
  }, []);

  async function upgrade() {
    setBusy(true);
    try {
      const r = await fetch("/api/billing/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan: "pro" }) });
      const d = await r.json().catch(() => ({}));
      if (d.url) { window.location.href = d.url; return; }
    } catch { /* ignore — settings page surfaces billing errors */ }
    setBusy(false);
  }

  const initial = (acct?.name || acct?.email || "?").trim().charAt(0).toUpperCase();

  return (
    <aside className="sidebar">
      <Link href="/" className="side-brand"><span className="logo"><Zap size={13} strokeWidth={2.4} /></span>SUPERSONIC</Link>

      <nav className="side-nav">
        <Link href="/" className={"side-nav-item" + (active === "apps" ? " active" : "")}><LayoutGrid size={15} />Apps</Link>
        <Link href="/settings" className={"side-nav-item" + (active === "settings" ? " active" : "")}><Settings size={15} />Settings</Link>
      </nav>

      <div className="side-spacer" />

      {acct && (
        <div className="side-acct">
          <div className="side-acct-id">
            <span className="acct-av">{initial}</span>
            <div className="acct-idtxt">
              {acct.name && <div className="acct-name">{acct.name}</div>}
              <div className="acct-email">{acct.email}</div>
            </div>
          </div>
          <div className="side-acct-plan">
            <span className={"plan-tag" + (acct.plan === "pro" ? " pro" : "")}><Sparkles size={12} />{acct.plan === "pro" ? "Pro" : "Basic"}</span>
            {acct.plan === "basic" && <button className="btn sm primary" disabled={busy} onClick={upgrade}>Upgrade</button>}
          </div>
          <button className="side-nav-item" onClick={() => signOut({ callbackUrl: "/login" })}><LogOut size={15} />Sign out</button>
        </div>
      )}
    </aside>
  );
}
