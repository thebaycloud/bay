"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";

// Per-user plan indicator for the dashboard topbar. Basic shows an Upgrade
// button (→ Stripe checkout); Pro shows a Manage button (→ Stripe portal). Until
// billing keys exist, checkout 503s and we say so rather than pretending.
export function PlanBadge() {
  const [plan, setPlan] = useState<"basic" | "pro" | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    fetch("/api/billing")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.plan) setPlan(d.plan); })
      .catch(() => {});
  }, []);

  if (!plan) return null;

  async function go(path: string, body?: unknown) {
    if (busy) return;
    setBusy(true); setNote("");
    try {
      const r = await fetch(path, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const d = await r.json().catch(() => ({}));
      if (d.url) { window.location.href = d.url; return; }
      setNote(d.error || "Billing isn't available yet.");
    } catch {
      setNote("Something went wrong.");
    }
    setBusy(false);
  }

  return (
    <div className="planbadge" title={note || undefined}>
      {plan === "pro" ? (
        <button className="btn sm plan-pro" disabled={busy} onClick={() => go("/api/billing/portal")}>
          <Sparkles size={12} /> Pro
        </button>
      ) : (
        <button className="btn sm plan-up" disabled={busy} onClick={() => go("/api/billing/checkout", { plan: "pro" })}>
          <Sparkles size={12} /> Upgrade
        </button>
      )}
    </div>
  );
}
