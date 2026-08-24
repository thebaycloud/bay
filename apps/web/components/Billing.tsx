"use client";

import { useState } from "react";
import { Check, ExternalLink, Infinity as InfinityIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Row, RowGroup } from "@/components/panel/atoms";
import { RowSkeleton } from "@/components/Skeleton";
import { resetsOn } from "@/lib/billing-period";
import { productName } from "@/lib/brand";
import { cn } from "@/lib/utils";

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
  "mailto:founders@thebay.cloud?subject=Bay%20Team%20plan"
  + "&body=Hi%20—%20I'd%20like%20to%20set%20up%20a%20Team%20plan.%0A%0AHow%20many%20people%20will%20be%20deploying%3A%0AWhat%20you're%20building%3A";

/**
 * One meter, as a row.
 *
 * An unlimited ceiling gets a number and no bar — there is no proportion to
 * draw. Amber at 80%, red at the ceiling: the point is that somebody notices
 * BEFORE the refusal rather than during it, because a build quota reached with no
 * warning reads as the platform breaking rather than as a plan working.
 */
function Meter({ label, used, max }: { label: string; used: number; max: number | null }) {
  if (max == null) {
    return (
      <Row title={label}>
        <span className="flex items-center gap-1.5 text-[13px] text-ink-2">
          <InfinityIcon className="size-3.5" />
          {used}
        </span>
      </Row>
    );
  }
  const pct = Math.min(100, (used / (max || 1)) * 100);
  const at = used >= max;
  const near = !at && pct >= 80;
  return (
    <Row title={label}>
      <span className="flex items-center gap-3">
        <span className="h-1.5 w-[120px] overflow-hidden rounded-full bg-tile">
          <span
            className={cn(
              "block h-full rounded-full",
              at ? "bg-red" : near ? "bg-[var(--amber,#B45309)]" : "bg-ink-3",
            )}
            style={{ width: `${pct}%` }}
          />
        </span>
        <span
          className={cn(
            "text-[13px] tabular-nums",
            at ? "text-red" : near ? "text-ink" : "text-ink-2",
          )}
        >
          {used}/{max}
        </span>
      </span>
    </Row>
  );
}

/**
 * Plan, usage and the way to change it.
 *
 * Deliberately shows the meters even to somebody who is nowhere near them.
 * Everywhere else in the product usage is silent until it matters — the banner
 * only appears near a limit — but settings is the one screen a person opens *to
 * find out*, so answering the question is the whole job.
 */
export function Billing({ acct }: { acct: BillingAccount | null }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const plan = acct?.plan ?? "free";
  const paid = plan === "pro" || plan === "team";
  const u = acct?.usage;

  async function go(path: string, body?: unknown) {
    setBusy(true);
    setNote("");
    try {
      const r = await fetch(path, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const d = await r.json().catch(() => ({}));
      if (d.url) {
        window.location.href = d.url;
        return;
      }
      setNote(d.error || "Billing isn't available yet.");
    } catch {
      setNote("Something went wrong.");
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-3">
      <RowGroup title="Plan">
        {/* Skeletons until the account answers. Rendering the free plan's row
            while the answer is unknown tells a Pro subscriber they are on Free
            for as long as the request takes — a placeholder that is wrong is
            worse than one that is blank. */}
        {!acct ? (
          <>
            <RowSkeleton tile={false} w={120} />
            <RowSkeleton tile={false} w={96} />
            <RowSkeleton tile={false} w={132} />
            <RowSkeleton tile={false} w={148} />
          </>
        ) : null}

        {acct ? (
          <Row
            sub={plan === "free" ? "no card, no time limit" : "manage or cancel any time"}
            title={LABEL[plan]}
          >
            <span className="text-[13px] text-ink-2">{PRICE[plan]}</span>
            {/* A subscriber manages their own subscription through Stripe's
                portal — cancelling, changing card, invoices. We do not rebuild
                any of that, and a Team account without a Stripe customer falls
                back to email, which is how it was sold in the first place. */}
            {paid ? (
              <Button
                disabled={busy}
                onClick={() => go("/api/billing/portal")}
                size="sm"
                variant="outline"
              >
                Manage billing
                <ExternalLink className="size-3.5" />
              </Button>
            ) : (
              <Button
                disabled={busy}
                onClick={() => go("/api/billing/checkout", { plan: "pro" })}
                size="sm"
              >
                Upgrade to Pro
              </Button>
            )}
          </Row>
        ) : null}

        {u ? (
          <>
            <Meter label="Apps" max={u.maxApps} used={u.apps} />
            <Meter label="Public apps" max={u.maxPublicApps} used={u.publicApps} />
            <Meter label="Builds this month" max={u.monthlyBuilds} used={u.builds} />
            {/* On free the monthly agent allowance is zero by design — the grant
                is a single lifetime one — so a "0/0" meter would say nothing
                true. The state that matters there is whether it is still
                available. */}
            {plan === "free" ? (
              <Row title="Free auto-fix">
                <span
                  className={cn("text-[13px]", u.freeFixAvailable ? "text-ink-2" : "text-red")}
                >
                  {u.freeFixAvailable ? "available" : "used"}
                </span>
              </Row>
            ) : (
              <Meter label="Auto-fix this month" max={u.monthlyAgentRuns} used={u.agentRuns} />
            )}
          </>
        ) : null}
      </RowGroup>

      {u ? (
        <p className="px-0.5 text-[13px] text-ink-3">
          Builds and auto-fix reset on {resetsOn(u.periodStart)}. Apps stay as they are.
        </p>
      ) : null}

      {/* What upgrading buys, only where there is something to buy. On Pro this
          block would be a list of things the reader already has. */}
      {acct && plan === "free" ? (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-ground px-4 py-3.5">
          <span className="text-[14px] font-[450] text-ink">Pro adds</span>
          <ul className="flex flex-col gap-1.5">
            {[
              "Unlimited apps and unlimited public apps",
              "Your own domain",
              "Auto-fix on every failed deploy, not just the first",
              `No “Runs on ${productName()}” badge`,
              "Backups and restore",
            ].map((line) => (
              <li className="flex items-center gap-2 text-[13px] text-ink-2" key={line}>
                <Check className="size-3.5 shrink-0 text-ink-3" />
                {line}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {acct ? (
      <p className="px-0.5 text-[13px] text-ink-3">
        {plan === "team" ? (
          <>
            Questions about your plan?{" "}
            <a className="text-ink underline" href={TEAM_MAILTO}>
              Email us
            </a>
            .
          </>
        ) : (
          <>
            Need seats for a whole team, or sign-in with your company domain?{" "}
            <a className="text-ink underline" href={TEAM_MAILTO}>
              Talk to us
            </a>
            .
          </>
        )}
      </p>
      ) : null}

      {note ? <p className="px-0.5 text-[14px] text-red">{note}</p> : null}
    </div>
  );
}
