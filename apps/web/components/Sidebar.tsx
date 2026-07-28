"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { Zap, LayoutGrid, Settings, LogOut, Sparkles, X } from "lucide-react";
import { Paywall } from "./Paywall";

interface Acct {
  email: string;
  name: string | null;
  plan: "basic" | "pro";
  access?: "trial" | "active" | "locked";
  usage?: { apps: number; maxApps: number | null; maxGrants: number | null };
}

// Persistent left rail: brand, nav, and the account block pinned to the bottom.
export function Sidebar({ active }: { active?: "apps" | "settings" }) {
  const [acct, setAcct] = useState<Acct | null>(null);
  const [showPlans, setShowPlans] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);

  useEffect(() => {
    fetch("/api/account").then((r) => (r.ok ? r.json() : null)).then((d) => { if (d?.email) setAcct(d); }).catch(() => {});
  }, []);

  const initial = (acct?.name || acct?.email || "?").trim().charAt(0).toUpperCase();
  const onTrial = acct?.access === "trial";
  const canUpgrade = onTrial || acct?.plan === "basic";
  const meter = acct?.usage && acct.usage.maxApps != null ? acct.usage : null;

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
            <span className={"plan-tag" + (onTrial || acct.plan === "pro" ? " pro" : "")}>
              <Sparkles size={12} />{onTrial ? "Trial" : acct.plan === "pro" ? "Pro" : "Basic"}
            </span>
            {canUpgrade && <button className="btn sm primary" onClick={() => setShowPlans(true)}>Upgrade</button>}
          </div>
          {meter && (
            <div className="usage">
              <div className="usage-row"><span>Apps</span><span>{meter.apps}/{meter.maxApps}</span></div>
              <div className="usage-bar"><span style={{ width: `${Math.min(100, (meter.apps / (meter.maxApps || 1)) * 100)}%` }} /></div>
            </div>
          )}
          {confirmOut ? (
            <div className="signout-confirm">
              <span className="dd-confirmq">Sign out?</span>
              <button className="side-nav-item danger" onClick={() => signOut({ callbackUrl: "/login" })}><LogOut size={15} />Yes, sign out</button>
              <button className="side-nav-item" onClick={() => setConfirmOut(false)}><X size={15} />Cancel</button>
            </div>
          ) : (
            <button className="side-nav-item" onClick={() => setConfirmOut(true)}><LogOut size={15} />Sign out</button>
          )}
        </div>
      )}

      {showPlans && <Paywall reason="choose_plan" onClose={() => setShowPlans(false)} />}
    </aside>
  );
}
