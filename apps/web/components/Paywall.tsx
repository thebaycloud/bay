"use client";

import { useState } from "react";
import { Sparkles, Check, X } from "lucide-react";
// Not the literal. This card promised to remove the "Supersonic badge" while the
// badge itself has said "Runs on Bay" since PRODUCT_NAME was set on the edge, so
// the one sentence selling the feature named a thing the product no longer calls
// itself. `productName()` reads NEXT_PUBLIC_PRODUCT_NAME, which Next inlines into
// this client bundle, so it agrees with the proxy that renders the badge.
import { productName } from "@/lib/brand";

// Free is not offered here, because everybody looking at this is already on it.
// The card that would say "Free — $0 — you have this" is the one thing a person
// hitting a limit does not need to read.
const PLANS = [
  {
    id: "pro", name: "Pro", price: "$20", unit: "/ month", featured: true,
    tagline: "Unlimited apps, no badge, and deploys that fix themselves.",
    features: [
      "Unlimited apps",
      "Unlimited public apps",
      "Your own domain",
      "Auto-fix on every failed deploy",
      `Remove the ${productName()} badge`,
      "Backups and restore",
    ],
  },
  {
    id: "team", name: "Team", price: "Let's talk", unit: "",
    tagline: "For a team whose internal tools all live in one place.",
    features: [
      "Everything in Pro",
      "Sign in with your company domain",
      "Roles and an audit log",
      "Unlimited recipients, always free",
      "Priority support",
    ],
  },
];

export type PaywallReason =
  | "app_limit"
  | "public_limit"
  | "build_limit"
  | "fix_used"
  | "choose_plan"
  | "no_account";

// Every one of these is written as an offer rather than a denial. Reaching a
// limit on the free plan is the best signal we get from a user — they built
// three things and want a fourth — and "you have hit your limit" is a strange
// way to answer good news.
const HEAD: Record<PaywallReason, { title: string; sub: string }> = {
  app_limit: {
    title: "You're using all three free apps",
    sub: "Pro is $20/month for as many as you like. Your three keep running either way.",
  },
  public_limit: {
    title: "Free includes one public app",
    sub: "You can still share any app by email with as many people as you want — that's never capped.",
  },
  build_limit: {
    title: "You've used this month's builds",
    sub: "They reset on the 1st. Pro raises the ceiling to 500 a month.",
  },
  fix_used: {
    title: "That was your free auto-fix",
    sub: "You'll still get a paste-ready fix for your coding agent on every failure. Pro has our agent do it for you.",
  },
  choose_plan: {
    title: `Upgrade ${productName()}`,
    sub: "You're on the free plan. Here's what the paid ones add.",
  },
  no_account: {
    title: "We couldn't find your account",
    sub: "Try signing out and back in — nothing you've deployed has been touched.",
  },
};

const TEAM_MAILTO =
  "mailto:founders@supersonic.cv?subject=Bay%20Team%20plan"
  + "&body=Hi%20—%20I'd%20like%20to%20set%20up%20a%20Team%20plan.%0A%0AHow%20many%20people%20will%20be%20deploying%3A%0AWhat%20you're%20building%3A";

/**
 * The upgrade surface.
 *
 * Always dismissable now, which is the change that matters. It used to be a
 * wall you could not close when a trial ran out — there was nothing behind it
 * to use. There is no trial any more, so there is always something behind it:
 * the free plan, with your apps on it, still running.
 */
export function Paywall({ reason = "choose_plan", onClose }: { reason?: PaywallReason; onClose?: () => void }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
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
    <div className="pw-overlay" onClick={onClose}>
      <div className="pw-card" onClick={(e) => e.stopPropagation()}>
        {onClose && <button className="pw-x" title="Close" onClick={onClose}><X size={16} /></button>}
        <div className="pw-head"><h2>{h.title}</h2><p>{h.sub}</p></div>
        <div className="pw-plans">
          {PLANS.map((pl) => (
            <div key={pl.id} className={"pw-plan" + (pl.featured ? " featured" : "")}>
              {pl.featured && <span className="pw-tagbadge"><Sparkles size={11} />Recommended</span>}
              <div className="pw-name">{pl.name}</div>
              <div className="pw-price"><b>{pl.price}</b> {pl.unit}</div>
              <div className="pw-tag">{pl.tagline}</div>
              <ul className="pw-feats">{pl.features.map((f) => <li key={f}><Check size={13} />{f}</li>)}</ul>
              {/* Team is an email, not a checkout. It is hand-priced while we
                  learn what it is worth, and routing it through Stripe only to
                  answer "talk to us" would be a round trip to reach a mailto. */}
              {pl.id === "team" ? (
                <a className="btn" href={TEAM_MAILTO}>Talk to us</a>
              ) : (
                <button className={"btn " + (pl.featured ? "primary" : "")} disabled={!!busy} onClick={() => pick(pl.id)}>
                  {busy === pl.id ? "…" : `Choose ${pl.name}`}
                </button>
              )}
            </div>
          ))}
        </div>
        {err && <div className="pw-err">⚠ {err}</div>}
      </div>
    </div>
  );
}
