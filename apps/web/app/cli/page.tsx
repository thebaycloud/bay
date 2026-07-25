"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

function CliAuth() {
  const sp = useSearchParams();
  const port = sp.get("port");
  const name = sp.get("name") || "cli";
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [token, setToken] = useState("");
  const [msg, setMsg] = useState("");

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
      setToken(d.token); setState("done");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e)); setState("error");
    }
  }

  // position:relative + z-index:1 lifts this above the fixed graph-paper grid
  // (body::before, z-index:0), which otherwise paints over the content.
  return (
    <div style={{ position: "relative", zIndex: 1, maxWidth: 480, margin: "14vh auto", padding: "0 24px", fontFamily: "var(--mono, ui-monospace, monospace)" }}>
      <div style={{ border: "1px solid var(--line)", background: "var(--card)", padding: 30 }}>
        <div style={{ fontSize: 12, letterSpacing: 2, color: "var(--ink-2)", marginBottom: 8 }}>SUPERSONIC / CLI</div>
        <h1 style={{ fontSize: 22, margin: "0 0 12px", color: "var(--ink)" }}>Authorize the CLI</h1>
        <p style={{ fontSize: 13, lineHeight: 1.6, color: "var(--ink-2)", margin: "0 0 22px" }}>
          This connects <b style={{ color: "var(--ink)" }}>{name}</b> to your Supersonic account so your coding agent can deploy and manage apps from the terminal.
        </p>

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
            <code style={{ display: "block", padding: 12, background: "var(--paper)", border: "1px solid var(--line)", wordBreak: "break-all", fontSize: 12, color: "var(--ink)" }}>
              supersonic login --token {token}
            </code>
          </div>
        )}

        {state === "error" && <p style={{ fontSize: 13, color: "#e5484d" }}>⚠ {msg}</p>}
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
