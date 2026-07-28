"use client";

import { useState } from "react";
import { Sparkles, Check, X } from "lucide-react";

const PLANS = [
  {
    id: "basic", name: "Basic", price: 12, tagline: "Ship one app, share it with your team.",
    features: ["1 app", "Database, storage & custom domain", "Share with up to 3 people", "Paste-ready fixes when something breaks"],
  },
  {
    id: "pro", name: "Pro", price: 20, tagline: "Unlimited apps, plus auto-fix.", featured: true,
    features: ["Unlimited apps", "Unlimited sharing + roles", "Failed deploys fix themselves", "Remove the Supersonic badge"],
  },
];

export type PaywallReason = "trial_ended" | "app_limit" | "share_limit" | "choose_plan";

const HEAD: Record<PaywallReason, { title: string; sub: string }> = {
  trial_ended: { title: "Your free trial has ended", sub: "Pick a plan to keep deploying, sharing, and building." },
  app_limit: { title: "You've hit your app limit", sub: "Basic includes 1 app — upgrade to Pro for unlimited apps." },
  share_limit: { title: "You've hit your sharing limit", sub: "Basic shares with 3 people — upgrade to Pro for unlimited sharing." },
  choose_plan: { title: "Choose your plan", sub: "You're on a free trial with full Pro access. Lock in a plan any time." },
};

// Shared plan-selection surface. Full-screen and non-dismissable when the trial
// has ended (there's nothing behind it to use); a dismissable modal otherwise.
export function Paywall({ reason = "trial_ended", onClose }: { reason?: PaywallReason; onClose?: () => void }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const dismissable = reason !== "trial_ended" && !!onClose;
  const h = HEAD[reason];

  async function pick(plan: string) {
    setBusy(plan); setErr("");
    try {
      const r = await fetch("/api/billing/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan }) });
      const d = await r.json().catch(() => ({}));
      if (d.url) { window.location.href = d.url; return; }
      setErr(d.error || "Billing isn't available right now.");
    } catch { setErr("Something went wrong."); }
    setBusy("");
  }

  return (
    <div className="pw-overlay" onClick={dismissable ? onClose : undefined}>
      <div className="pw-card" onClick={(e) => e.stopPropagation()}>
        {dismissable && <button className="pw-x" title="Close" onClick={onClose}><X size={16} /></button>}
        <div className="pw-head"><h2>{h.title}</h2><p>{h.sub}</p></div>
        <div className="pw-plans">
          {PLANS.map((pl) => (
            <div key={pl.id} className={"pw-plan" + (pl.featured ? " featured" : "")}>
              {pl.featured && <span className="pw-tagbadge"><Sparkles size={11} />Recommended</span>}
              <div className="pw-name">{pl.name}</div>
              <div className="pw-price"><b>${pl.price}</b> / mo</div>
              <div className="pw-tag">{pl.tagline}</div>
              <ul className="pw-feats">{pl.features.map((f) => <li key={f}><Check size={13} />{f}</li>)}</ul>
              <button className={"btn " + (pl.featured ? "primary" : "")} disabled={!!busy} onClick={() => pick(pl.id)}>
                {busy === pl.id ? "…" : `Choose ${pl.name}`}
              </button>
            </div>
          ))}
        </div>
        {err && <div className="pw-err">⚠ {err}</div>}
      </div>
    </div>
  );
}
