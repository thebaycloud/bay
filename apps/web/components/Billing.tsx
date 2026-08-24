"use client";

import { useState } from "react";
import { Check, ExternalLink, Infinity as InfinityIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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

/**
 * One limit: what it is, how full it is, and how much is left.
 *
 * The shape is Claude's usage meter — a label with its reset beneath, a long
 * track that takes the space, the number on the right. It replaces four rows of a
 * hairline table whose entire content was "∞ 1", which said almost nothing and
 * looked like a table of nothings.
 *
 * `N of M` rather than a percentage. A percentage is how you read a meter with a
 * large ceiling; these ceilings are 3 and 10, and "33% used" of three apps is a
 * worse sentence than "1 of 3".
 *
 * "Deploys", not "Builds". The counter is incremented once per deploy dispatched
 * — see `countIfUnder` in /api/deploy — so "builds" named an internal unit for
 * something a person did. The column stays `builds`; the word somebody reads
 * does not have to match a column name.
 */
function Meter({
  label,
  used,
  max,
  resets,
}: {
  label: string;
  used: number;
  max: number | null;
  resets?: string;
}) {
  const unlimited = max == null;
  const pct = unlimited ? 0 : Math.min(100, (used / (max || 1)) * 100);
  const at = !unlimited && used >= max;
  const near = !unlimited && !at && pct >= 80;

  return (
    <div className="flex items-center gap-5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-none sm:basis-[168px]">
        <span className="text-[14px] font-[450] text-ink">{label}</span>
        {resets ? <span className="text-[13px] text-ink-3">{resets}</span> : null}
      </div>

      {/* Every row gets a track, unlimited included — but an unlimited one is
          drawn as a fill that FADES OUT to the right rather than as a percentage.
          There is no proportion to draw, and a solid bar at any width is a number
          somebody will read: a quarter-full says "25%", a full one says "you are
          at the limit". A fill running off the end says the thing that is true —
          it keeps going. */}
      <span className="hidden h-2 flex-1 overflow-hidden rounded-full bg-tile sm:block">
        {unlimited ? (
          <span className="block h-full rounded-full bg-gradient-to-r from-ink-3 to-transparent" />
        ) : (
          // A floor of 4% on anything above zero: one of ten apps is 10% and
          // draws as a sliver, and a sliver reads as a rendering artefact rather
          // than as "you have used one".
          <span
            className={cn(
              "block h-full rounded-full transition-[width]",
              at ? "bg-red" : near ? "bg-[#B45309]" : "bg-ink",
            )}
            style={{ width: `${used > 0 ? Math.max(pct, 4) : 0}%` }}
          />
        )}
      </span>
      <span
        className={cn(
          "flex shrink-0 items-center gap-1.5 text-[13px] tabular-nums",
          at ? "text-red" : near ? "text-ink" : "text-ink-2",
        )}
      >
        {unlimited ? (
          <>
            <InfinityIcon className="size-3.5" />
            {used} used
          </>
        ) : (
          `${used} of ${max}`
        )}
      </span>
    </div>
  );
}

/** The plan, and the way to change it. */
export function Plan({ acct }: { acct: BillingAccount | null }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const plan = acct?.plan ?? "free";
  const paid = plan === "pro" || plan === "team";

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
        {/* Skeleton until the account answers. Rendering the free plan's row
            while the answer is unknown tells a Pro subscriber they are on Free
            for as long as the request takes — a placeholder that is wrong is
            worse than one that is blank. */}
        {acct ? (
          <Row title={LABEL[plan]}>
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
        ) : (
          <RowSkeleton tile={false} w={120} />
        )}
      </RowGroup>

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

      {note ? <p className="px-0.5 text-[14px] text-red">{note}</p> : null}
    </div>
  );
}

/**
 * Usage, as its own section.
 *
 * Split from Plan because they answer different questions — what am I paying
 * for, and how much of it is left — and reading them as one list made the plan
 * row look like the first of five limits.
 *
 * Shown even to somebody nowhere near a ceiling. Everywhere else usage is silent
 * until it matters, but this is the screen a person opens *to find out*.
 */
export function Usage({ acct }: { acct: BillingAccount | null }) {
  const u = acct?.usage;
  const plan = acct?.plan ?? "free";
  const resets = u ? `resets ${resetsOn(u.periodStart)}` : undefined;

  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="px-0.5 text-[15px] text-ink">Usage</h2>
      <div className="flex flex-col gap-5 rounded-xl border border-border bg-card px-5 py-[18px]">
        {!u ? (
          [0, 1, 2, 3].map((i) => (
            <div className="flex items-center gap-5" key={i}>
              <Skeleton className="h-4 w-[120px]" />
              <Skeleton className="hidden h-2 flex-1 rounded-full sm:block" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))
        ) : (
          <>
            <Meter label="Apps" max={u.maxApps} used={u.apps} />
            <Meter label="Public apps" max={u.maxPublicApps} used={u.publicApps} />

            {/* A hairline where the meaning changes: the two above are standing
                totals, the two below are spent and given back every month. */}
            <span className="h-px bg-border" />

            <Meter label="Deploys" max={u.monthlyBuilds} resets={resets} used={u.builds} />
            {plan === "free" ? (
              // On free the monthly allowance is zero and the grant is a single
              // lifetime one, so this IS a meter of one — drawn as such rather
              // than as a sentence beside four bars.
              <Meter
                label="Auto-fix"
                max={1}
                resets="one on the free plan"
                used={u.freeFixAvailable ? 0 : 1}
              />
            ) : (
              <Meter label="Auto-fix" max={u.monthlyAgentRuns} resets={resets} used={u.agentRuns} />
            )}
          </>
        )}
      </div>
    </section>
  );
}
