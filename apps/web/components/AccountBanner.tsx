"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { Paywall, type PaywallReason } from "./Paywall";

interface Usage {
  apps: number;
  maxApps: number | null;
  publicApps: number;
  maxPublicApps: number | null;
  builds: number;
  monthlyBuilds: number | null;
  freeFixAvailable?: boolean;
}

interface Acct {
  access?: string;
  plan?: string;
  usage?: Usage;
}

/**
 * The one banner the dashboard shows about your plan — and most of the time it
 * shows nothing at all.
 *
 * It replaces a trial countdown that was on screen every day of a user's first
 * three, saying the same thing each time. There is no trial now, so there is
 * nothing to count down and nothing to say until a limit is actually close.
 * Silence is the correct default for chrome about billing: a person who is
 * within their plan does not need to be reminded they have a plan.
 */
export function AccountBanner() {
  const [acct, setAcct] = useState<Acct | null>(null);
  const [reason, setReason] = useState<PaywallReason | null>(null);

  useEffect(() => {
    fetch("/api/account").then((r) => (r.ok ? r.json() : null)).then((d) => { if (d?.access) setAcct(d); }).catch(() => {});
  }, []);

  if (!acct) return null;
  // Reachable only when there is no user row at all — a lapsed subscription
  // drops to free rather than locking. Not dismissable, because unlike a plan
  // limit there is genuinely nothing behind it.
  if (acct.access === "locked") return <Paywall reason="no_account" />;

  const u = acct.usage;
  if (!u) return null;

  // Only ever nags at the edge of a limit, and only about the one that is
  // closest. Two banners about two meters is how chrome becomes wallpaper.
  const atApps = u.maxApps != null && u.apps >= u.maxApps;
  const atPublic = u.maxPublicApps != null && u.publicApps >= u.maxPublicApps;
  const nearBuilds = u.monthlyBuilds != null && u.builds >= Math.floor(u.monthlyBuilds * 0.8);

  const nudge: { reason: PaywallReason; text: React.ReactNode } | null = atApps
    ? { reason: "app_limit", text: <><b>You're using all {u.maxApps} free apps.</b> Pro is $20/month for unlimited.</> }
    : nearBuilds
      ? { reason: "build_limit", text: <><b>{u.builds} of {u.monthlyBuilds} builds used this month.</b> They reset on the 1st.</> }
      : atPublic
        ? { reason: "public_limit", text: <><b>Your one public app is in use.</b> Sharing by email is still unlimited.</> }
        : null;

  if (!nudge) return null;

  return (
    <>
      <div className="trial-banner">
        <Sparkles size={13} />
        <span>{nudge.text}</span>
        <button className="btn accent sm tb-btn" onClick={() => setReason(nudge.reason)}>See plans</button>
      </div>
      {reason && <Paywall reason={reason} onClose={() => setReason(null)} />}
    </>
  );
}
