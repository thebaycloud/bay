"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { signOut } from "next-auth/react";

interface Tok { id: string; name: string | null; created_at: string; last_used_at: string | null }
interface Acct { email: string; name: string | null }

function shortDate(s: string | null): string {
  if (!s) return "never";
  try { return new Date(s).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
  catch { return "—"; }
}

const line = "1px solid var(--line)";

function CliAuth() {
  const sp = useSearchParams();
  const port = sp.get("port");
  const name = sp.get("name") || "cli";
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [token, setToken] = useState("");
  const [msg, setMsg] = useState("");

  // Who this authorization would attach to, and what is already attached. The
  // page used to say neither: you pressed Authorize and a token appeared, with
  // no way to see that the last four machines still hold one — or that you are
  // signed in as the wrong account.
  const [acct, setAcct] = useState<Acct | null>(null);
  const [tokens, setTokens] = useState<Tok[] | null>(null);
  const [freshId, setFreshId] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const loadTokens = useCallback(async () => {
    try {
      const r = await fetch("/api/cli/token");
      const d = await r.json();
      setTokens(d.tokens ?? []);
    } catch { setTokens([]); }
  }, []);

  useEffect(() => {
    fetch("/api/account").then((r) => r.json()).then((d) => { if (d.email) setAcct(d); }).catch(() => {});
    loadTokens();
  }, [loadTokens]);

  async function authorize() {
    setState("working"); setMsg("");
    try {
      const r = await fetch("/api/cli/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "failed to mint token");
      if (port) {
        setState("done");
        window.location.href = `http://127.0.0.1:${port}/callback?token=${encodeURIComponent(d.token)}`;
        return;
      }
      setToken(d.token); setFreshId(d.id); setState("done");
      loadTokens();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e)); setState("error");
    }
  }

  async function revoke(id: string) {
    setRevoking(id);
    try {
      const r = await fetch(`/api/cli/token?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const d = await r.json().catch(() => ({}));
      // The route answers 200 with `ok:false` for an id that is not yours —
      // taking that as success would drop the row from the list while the
      // token kept working, which is the one lie this panel must not tell.
      if (!r.ok || d.error || d.ok === false) throw new Error(d.error || "couldn't revoke that one");
      setTokens((t) => (t ?? []).filter((x) => x.id !== id));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setRevoking(null); setConfirmingId(null);
    }
  }

  // Signing out from here has to come back here: the CLI is holding a loopback
  // port open, and dropping the visitor on the dashboard would strand it until
  // it times out.
  async function switchAccount() {
    await signOut({ redirect: false });
    const back = window.location.pathname + window.location.search;
    window.location.href = `/login?callbackUrl=${encodeURIComponent(back)}`;
  }

  // position:relative + z-index:1 lifts this above the fixed graph-paper grid
  // (body::before, z-index:0), which otherwise paints over the content.
  return (
    <div style={{ position: "relative", zIndex: 1, maxWidth: 480, margin: "14vh auto 8vh", padding: "0 24px", fontFamily: "var(--mono, ui-monospace, monospace)" }}>
      <div style={{ border: line, background: "var(--card)", padding: 30 }}>
        <div style={{ fontSize: 12, letterSpacing: 2, color: "var(--ink-2)", marginBottom: 8 }}>SUPERSONIC / CLI</div>
        <h1 style={{ fontSize: 22, margin: "0 0 12px", color: "var(--ink)" }}>Authorize the CLI</h1>
        <p style={{ fontSize: 13, lineHeight: 1.6, color: "var(--ink-2)", margin: "0 0 18px" }}>
          This connects <b style={{ color: "var(--ink)" }}>{name}</b> to your Supersonic account so your coding agent can deploy and manage apps from the terminal.
        </p>

        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, padding: "10px 12px", border: line, background: "var(--paper)", marginBottom: 22 }}>
          <span style={{ fontSize: 12, color: "var(--ink-2)" }}>
            signed in as <b style={{ color: "var(--ink)" }}>{acct?.email ?? "…"}</b>
          </span>
          <button onClick={switchAccount}
            style={{ background: "none", border: "none", padding: 0, fontFamily: "inherit", fontSize: 12, color: "var(--ink-2)", textDecoration: "underline", cursor: "pointer" }}>
            not you?
          </button>
        </div>

        {state !== "done" && (
          <button onClick={authorize} disabled={state === "working"}
            style={{
              width: "100%", padding: "13px 16px", fontSize: 14, fontWeight: 600,
              fontFamily: "inherit", background: "var(--ink)", color: "var(--paper)",
              border: "1px solid var(--ink)", cursor: state === "working" ? "default" : "pointer",
              opacity: state === "working" ? 0.6 : 1,
            }}>
            {state === "working" ? "Authorizing…" : "Authorize"}
          </button>
        )}

        {state === "done" && port && (
          <p style={{ fontSize: 13, color: "var(--ink)" }}>✓ Authorized. You can close this tab and return to your terminal.</p>
        )}

        {state === "done" && !port && (
          <div>
            <p style={{ fontSize: 13, marginBottom: 8, color: "var(--ink)" }}>✓ Token created — paste this into your terminal:</p>
            <code style={{ display: "block", padding: 12, background: "var(--paper)", border: line, wordBreak: "break-all", fontSize: 12, color: "var(--ink)" }}>
              supersonic login --token {token}
            </code>
          </div>
        )}

        {state === "error" && <p style={{ fontSize: 13, color: "#e5484d" }}>⚠ {msg}</p>}
      </div>

      {/* Everything already holding a key to this account. A machine you no
          longer use, or one you don't recognize, is revoked from here. */}
      <div style={{ border: line, borderTop: "none", background: "var(--card)", padding: "22px 30px 26px" }}>
        <div style={{ fontSize: 12, letterSpacing: 1, color: "var(--ink-2)", marginBottom: 14 }}>AUTHORIZED CLIS</div>

        {tokens === null && <div style={{ fontSize: 13, color: "var(--ink-2)" }}>Loading…</div>}
        {tokens?.length === 0 && (
          <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6 }}>
            Nothing is authorized yet — this will be the first.
          </div>
        )}

        {tokens?.map((t) => (
          <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: line }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.name || "cli"}
                {t.id === freshId && <span style={{ marginLeft: 8, fontSize: 11, color: "var(--ink-2)" }}>· just now</span>}
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-2)", marginTop: 3 }}>
                added {shortDate(t.created_at)} · last used {shortDate(t.last_used_at)}
              </div>
            </div>
            {confirmingId === t.id ? (
              <span style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                <button onClick={() => revoke(t.id)} disabled={revoking === t.id}
                  style={{ fontFamily: "inherit", fontSize: 12, padding: "5px 10px", border: "1px solid #e5484d", background: "#e5484d", color: "var(--card)", cursor: "pointer" }}>
                  {revoking === t.id ? "…" : "Revoke"}
                </button>
                <button onClick={() => setConfirmingId(null)}
                  style={{ fontFamily: "inherit", fontSize: 12, padding: "5px 10px", border: line, background: "var(--card)", color: "var(--ink-2)", cursor: "pointer" }}>
                  Cancel
                </button>
              </span>
            ) : (
              <button onClick={() => { setConfirmingId(t.id); setMsg(""); }}
                style={{ flexShrink: 0, fontFamily: "inherit", fontSize: 12, padding: "5px 10px", border: line, background: "var(--card)", color: "var(--ink-2)", cursor: "pointer" }}>
                Revoke
              </button>
            )}
          </div>
        ))}

        {tokens && tokens.length > 0 && (
          <p style={{ fontSize: 11, color: "var(--ink-2)", lineHeight: 1.6, margin: "14px 0 0" }}>
            Revoking takes effect immediately — that machine&apos;s next command is rejected and it has to sign in again.
          </p>
        )}
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <CliAuth />
    </Suspense>
  );
}
