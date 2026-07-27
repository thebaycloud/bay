"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  User, CreditCard, Terminal, AlertTriangle, Trash2, Loader2, Check, Sparkles, ExternalLink,
} from "lucide-react";
import { Sidebar } from "@/components/Sidebar";

interface Account { email: string; name: string | null; provider: string; hasPassword: boolean; plan: "basic" | "pro"; }
interface Tok { id: string; name: string | null; created_at: string; last_used_at: string | null; }

const providerLabel: Record<string, string> = { google: "Google", github: "GitHub", credentials: "Email & password" };
function shortDate(s: string | null): string {
  if (!s) return "never";
  try { return new Date(s).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
  catch { return "—"; }
}

export default function Settings() {
  const router = useRouter();
  const [acct, setAcct] = useState<Account | null>(null);
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);

  const [tokens, setTokens] = useState<Tok[] | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [billingBusy, setBillingBusy] = useState(false);
  const [billingNote, setBillingNote] = useState("");

  const [confirm, setConfirm] = useState("");
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState("");

  useEffect(() => {
    fetch("/api/account").then((r) => r.json()).then((d) => { if (d.email) { setAcct(d); setName(d.name ?? ""); } }).catch(() => {});
    fetch("/api/account/tokens").then((r) => r.json()).then((d) => setTokens(d.tokens ?? [])).catch(() => setTokens([]));
  }, []);

  async function saveName() {
    setSavingName(true); setNameSaved(false);
    const r = await fetch("/api/account", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    setSavingName(false);
    if (r.ok) { setNameSaved(true); setTimeout(() => setNameSaved(false), 2000); }
  }

  async function revoke(id: string) {
    const r = await fetch("/api/account/tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revoke: id }) });
    setConfirmingId(null);
    if (r.ok) setTokens((t) => (t ?? []).filter((x) => x.id !== id));
  }

  async function billing(path: string, body?: unknown) {
    setBillingBusy(true); setBillingNote("");
    try {
      const r = await fetch(path, { method: "POST", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
      const d = await r.json().catch(() => ({}));
      if (d.url) { window.location.href = d.url; return; }
      setBillingNote(d.error || "Billing isn't available yet.");
    } catch { setBillingNote("Something went wrong."); }
    setBillingBusy(false);
  }

  async function del() {
    setDelBusy(true); setDelErr("");
    const r = await fetch("/api/account/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setDelErr(d.error || "Couldn't delete the account."); setDelBusy(false); return; }
    await signOut({ redirect: false });
    router.push("/login");
  }

  return (
    <div className="shell shell-side">
      <Sidebar active="settings" />
      <div className="main">
        <div className="scroll">
          <div className="section-page">
          <div className="page-head"><h2>Settings</h2><p>Your account, plan, CLI access, and deleting your account.</p></div>

          {/* Account */}
          <div className="set-card">
            <div className="set-head"><User size={15} /><div><div className="st">Account</div><div className="ss">Your name and how you sign in.</div></div></div>
            <div className="kv">
              <div className="row"><span className="k">email</span><span className="v">{acct?.email ?? "…"}</span></div>
              <div className="row"><span className="k">signs in with</span><span className="v">{acct ? (providerLabel[acct.provider] ?? acct.provider) : "…"}</span></div>
            </div>
            <div className="env-add">
              <input className="in" placeholder="your name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") saveName(); }} />
              <button className="btn primary" disabled={savingName || !acct} onClick={saveName}>
                {savingName ? <Loader2 size={13} className="spin" /> : nameSaved ? <Check size={13} /> : null}{nameSaved ? "Saved" : "Save name"}
              </button>
            </div>
          </div>

          {/* Plan & billing */}
          <div className="set-card">
            <div className="set-head"><CreditCard size={15} /><div><div className="st">Plan &amp; billing</div><div className="ss">You&apos;re on the {acct?.plan === "pro" ? "Pro" : "Basic"} plan.</div></div></div>
            <div className="set-body">
              <div className="plan-line">
                <span className={"plan-tag" + (acct?.plan === "pro" ? " pro" : "")}><Sparkles size={12} />{acct?.plan === "pro" ? "Pro" : "Basic"}</span>
                {acct?.plan === "pro" ? (
                  <button className="btn" disabled={billingBusy} onClick={() => billing("/api/billing/portal")}>Manage billing <ExternalLink size={13} /></button>
                ) : (
                  <button className="btn primary" disabled={billingBusy} onClick={() => billing("/api/billing/checkout", { plan: "pro" })}>Upgrade to Pro</button>
                )}
              </div>
              {billingNote && <div className="set-err">⚠ {billingNote}</div>}
            </div>
          </div>

          {/* CLI tokens */}
          <div className="set-card">
            <div className="set-head"><Terminal size={15} /><div><div className="st">CLI tokens</div><div className="ss">Tokens your coding agent uses with the <span className="mono">supersonic</span> CLI. Revoke any you don&apos;t recognize.</div></div></div>
            <div className="env-list">
              {tokens === null && <div className="env-empty">Loading…</div>}
              {tokens?.length === 0 && <div className="env-empty">No CLI tokens yet. Run <span className="mono">supersonic login</span> to create one.</div>}
              {tokens?.map((t) => (
                <div className="env-row" key={t.id}>
                  <span className="ek">{t.name || "token"}</span>
                  <span className="tok-meta">created {shortDate(t.created_at)} · last used {shortDate(t.last_used_at)}</span>
                  {confirmingId === t.id ? (
                    <span className="tok-confirm">
                      <span className="tok-q">Revoke it?</span>
                      <button className="btn danger-btn sm" onClick={() => revoke(t.id)}>Revoke</button>
                      <button className="btn sm" onClick={() => setConfirmingId(null)}>Cancel</button>
                    </span>
                  ) : (
                    <button className="ic-btn" title="Revoke" onClick={() => setConfirmingId(t.id)}><Trash2 size={14} /></button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Danger zone */}
          <div className="set-card danger">
            <div className="set-head"><AlertTriangle size={15} /><div><div className="st">Delete account</div><div className="ss">Permanently deletes your account and every app you own — databases, files, and addresses. This can&apos;t be undone.</div></div></div>
            <div className="danger-confirm">
              <input className="in mono" placeholder="type your email to confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              <button className="btn danger-btn" disabled={delBusy || confirm.trim().toLowerCase() !== (acct?.email ?? "").toLowerCase()} onClick={del}>
                {delBusy ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />}Delete account
              </button>
            </div>
            {delErr && <div className="set-err">⚠ {delErr}</div>}
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}
