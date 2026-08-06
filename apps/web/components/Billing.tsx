"use client";

import { useState } from "react";
import { CreditCard, Sparkles, ExternalLink, Check, Infinity as InfinityIcon } from "lucide-react";
import { resetsOn } from "@/lib/billing-period";

/**
 * What the account payload carries about money. Every ceiling is `number | null`
 * because Infinity does not survive JSON — null is the wire form of unlimited,
 * and rendering it as a number is how you get "3/null" and a full progress bar.
 */
export interface BillingUsage {
  apps: number;
  maxApps: number | null;
  publicApps: number;
  maxPublicApps: number | null;
  builds: number;
  monthlyBuilds: number | null;
  agentRuns: number;
  monthlyAgentRuns: number | null;
  periodStart: string;
  freeFixAvailable?: boolean;
}

export interface BillingAccount {
  plan: "free" | "pro" | "team";
  status?: string;
  usage?: BillingUsage;
  features?: { autoFix: boolean; customDomains: boolean; canRemoveBadge: boolean };
}

const LABEL: Record<string, string> = { free: "Free", pro: "Pro", team: "Team" };
const PRICE: Record<string, string> = { free: "$0 / forever", pro: "$20 / month", team: "Custom" };

const TEAM_MAILTO =
  "mailto:founders@supersonic.cv?subject=Supersonic%20Team%20plan"
  + "&body=Hi%20—%20I'd%20like%20to%20set%20up%20a%20Team%20plan.%0A%0AHow%20many%20people%20will%20be%20deploying%3A%0AWhat%20you're%20building%3A";

/** One meter. An unlimited ceiling gets a number and no bar — there is no proportion to draw. */
function Meter({ label, used, max }: { label: string; used: number; max: number | null }) {
  if (max == null) {
    return (
      <div className="bill-meter">
        <div className="bill-meter-row"><span>{label}</span><span className="bill-unlimited"><InfinityIcon size={12} />{used}</span></div>
      </div>
    );
  }
  const pct = Math.min(100, (used / (max || 1)) * 100);
  // Amber at 80%, red at the ceiling. The point is that a person notices before
  // the refusal rather than during it — a build quota reached with no warning
  // reads as the platform breaking, not as a plan working.
  const tone = used >= max ? " at" : pct >= 80 ? " near" : "";
  return (
    <div className="bill-meter">
      <div className="bill-meter-row"><span>{label}</span><span className={"bill-count" + tone}>{used}/{max}</span></div>
      <div className="bill-bar"><span className={tone.trim()} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

/**
 * Plan, usage and the way to change it.
 *
 * Deliberately shows the meters even to somebody who is nowhere near them.
 * Everywhere else in the product usage is silent until it matters (the sidebar
 * only draws a bar with a ceiling, the banner only appears near a limit) — but
 * settings is the one screen a person opens *to find out*, so answering the
 * question is the whole job.
 */
export function Billing({ acct }: { acct: BillingAccount | null }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const plan = acct?.plan ?? "free";
  const paid = plan === "pro" || plan === "team";
  const u = acct?.usage;

  async function go(path: string, body?: unknown) {
    setBusy(true); setNote("");
    try {
      const r = await fetch(path, { method: "POST", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
      const d = await r.json().catch(() => ({}));
      if (d.url) { window.location.href = d.url; return; }
      setNote(d.error || "Billing isn't available yet.");
    } catch { setNote("Something went wrong."); }
    setBusy(false);
  }

  return (
    <div className="set-card">
      <div className="set-head">
        <CreditCard size={15} />
        <div>
          <div className="st">Plan &amp; billing</div>
          <div className="ss">
            {plan === "free"
              ? "You're on the free plan — no card, no time limit."
              : `You're on ${LABEL[plan]}. Manage or cancel any time.`}
          </div>
        </div>
      </div>

      <div className="set-body">
        <div className="plan-line">
          <span className={"plan-tag" + (paid ? " pro" : "")}><Sparkles size={12} />{LABEL[plan]}</span>
          <span className="bill-price">{PRICE[plan]}</span>
          {/* A subscriber manages their own subscription through Stripe's
              portal — cancelling, changing card, invoices. We do not rebuild
              any of that, and a Team account without a Stripe customer falls
              back to email, which is how it was sold in the first place. */}
          {paid ? (
            <button className="btn" disabled={busy} onClick={() => go("/api/billing/portal")}>
              Manage billing <ExternalLink size={13} />
            </button>
          ) : (
            <button className="btn primary" disabled={busy} onClick={() => go("/api/billing/checkout", { plan: "pro" })}>
              Upgrade to Pro
            </button>
          )}
        </div>
      </div>

      {u && (
        <>
          <div className="bill-meters">
            <Meter label="Apps" used={u.apps} max={u.maxApps} />
            <Meter label="Public apps" used={u.publicApps} max={u.maxPublicApps} />
            <Meter label="Builds this month" used={u.builds} max={u.monthlyBuilds} />
            {/* On free the monthly agent allowance is zero by design — the grant
                is a single lifetime one — so a "0/0" meter would say nothing
                true. The state that matters there is whether it is still
                available. */}
            {plan === "free"
              ? (
                <div className="bill-meter">
                  <div className="bill-meter-row">
                    <span>Free auto-fix</span>
                    <span className={"bill-count" + (u.freeFixAvailable ? "" : " at")}>
                      {u.freeFixAvailable ? "available" : "used"}
                    </span>
                  </div>
                </div>
              )
              : <Meter label="Auto-fix this month" used={u.agentRuns} max={u.monthlyAgentRuns} />}
          </div>
          <div className="bill-foot">
            Builds and auto-fix reset on {resetsOn(u.periodStart)}. Apps stay as they are.
          </div>
        </>
      )}

      {/* What upgrading buys, only where there is something to buy. On Pro this
          block would be a list of things the reader already has. */}
      {plan === "free" && (
        <div className="bill-upsell">
          <div className="bill-upsell-h">Pro adds</div>
          <ul>
            <li><Check size={13} />Unlimited apps and unlimited public apps</li>
            <li><Check size={13} />Your own domain</li>
            <li><Check size={13} />Auto-fix on every failed deploy, not just the first</li>
            <li><Check size={13} />No &ldquo;Runs on Supersonic&rdquo; badge</li>
            <li><Check size={13} />Backups and restore</li>
          </ul>
        </div>
      )}

      <div className="bill-foot">
        {plan === "team"
          ? <>Questions about your plan? <a href={TEAM_MAILTO}>Email us</a>.</>
          : <>Need seats for a whole team, or sign-in with your company domain? <a href={TEAM_MAILTO}>Talk to us</a>.</>}
      </div>

      {note && <div className="set-err">⚠ {note}</div>}
    </div>
  );
}
