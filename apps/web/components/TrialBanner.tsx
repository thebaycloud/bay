"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { Paywall } from "./Paywall";

// One drop-in that reacts to the account's access state:
//  - locked  → full-screen paywall (trial ended / subscription gone)
//  - trial   → a countdown banner + a "choose a plan" modal
//  - active  → renders nothing
export function TrialBanner() {
  const [acct, setAcct] = useState<{ access?: string; trialEndsAt?: string | null } | null>(null);
  const [showPlans, setShowPlans] = useState(false);

  useEffect(() => {
    fetch("/api/account").then((r) => (r.ok ? r.json() : null)).then((d) => { if (d?.access) setAcct(d); }).catch(() => {});
  }, []);

  if (!acct) return null;
  if (acct.access === "locked") return <Paywall reason="trial_ended" />;
  if (acct.access !== "trial" || !acct.trialEndsAt) return null;

  const days = Math.max(0, Math.ceil((new Date(acct.trialEndsAt).getTime() - Date.now()) / 86_400_000));
  return (
    <>
      <div className="trial-banner">
        <Sparkles size={13} />
        <span><b>{days} day{days === 1 ? "" : "s"} left</b> in your free trial — full Pro access</span>
        <button className="btn accent sm tb-btn" onClick={() => setShowPlans(true)}>Choose a plan</button>
      </div>
      {showPlans && <Paywall reason="choose_plan" onClose={() => setShowPlans(false)} />}
    </>
  );
}
