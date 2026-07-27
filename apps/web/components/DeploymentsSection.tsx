"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw, Loader2, Check, Copy, Terminal } from "lucide-react";

interface DeployRow { slug: string; name: string | null; status: string; stage: string | null; url: string | null; }

export function DeploymentsSection({ slug, repo }: { slug: string; repo: string }) {
  const [live, setLive] = useState<DeployRow | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Poll the deploy store so a deploy started anywhere (CLI included) shows here live.
  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        const d = await (await fetch(`/api/apps/${slug}/deploy-status`)).json();
        if (stop) return;
        setLive(d.deploy ?? null);
        if (d.deploy?.status === "building") setTimeout(tick, 2500);
      } catch { /* ignore */ }
    }
    tick();
    return () => { stop = true; };
  }, [slug]);

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [logs]);

  // Redeploy from the browser (git-backed apps only) — streams the deploy log inline.
  async function redeploy() {
    setStreaming(true); setLogs([]);
    try {
      const res = await fetch("/api/deploy", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo }),
      });
      if (!res.body) throw new Error("no response stream");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const raw = part.replace(/^data: /, "").trim();
          if (!raw) continue;
          const ev = JSON.parse(raw);
          if (ev.type === "log") setLogs((l) => [...l, ev.line]);
          else if (ev.type === "done") setLogs((l) => [...l, `✓ live at ${ev.url}`]);
          else if (ev.type === "error") setLogs((l) => [...l, `✕ ${ev.message}`]);
        }
      }
    } catch (e) {
      setLogs((l) => [...l, `✕ ${e instanceof Error ? e.message : String(e)}`]);
    } finally {
      setStreaming(false);
    }
  }

  const building = live?.status === "building" || streaming;
  const cmd = "supersonic deploy";

  return (
    <>
      <div className="page-head"><h2>Deployments</h2><p>Ship an update and watch it go live.</p></div>

      {/* Live status */}
      <div className="dep-status">
        <span className={"dep-dot " + (building ? "building" : live?.status === "failed" ? "failed" : "live")} />
        <div className="dep-grow">
          <div className="dep-t">{building ? "Deploying…" : live?.status === "failed" ? "Last deploy failed" : "Up to date"}</div>
          <div className="dep-s">{building ? (live?.stage || "working…") : live?.status === "failed" ? (live?.stage || "") : "Your latest version is serving."}</div>
        </div>
        {repo
          ? <button className="btn primary" disabled={building} onClick={redeploy}>{building ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}Redeploy</button>
          : null}
      </div>

      {/* Log stream (browser-triggered redeploy) */}
      {logs.length > 0 && (
        <div className="dep-log" ref={logRef}>
          {logs.map((l, i) => {
            const ok = /^(✓|Detected|Provision|Live|Injecting|Agent fixed)/.test(l);
            const bad = /^✕/.test(l);
            return <div className="dl-ln" key={i}><span className={ok ? "g" : bad ? "r" : "dim"}>{ok ? <Check size={12} /> : bad ? "✕" : "·"}</span><span>{l}</span></div>;
          })}
        </div>
      )}

      {/* Redeploy help for apps published from a computer (no git) */}
      {!repo && (
        <div className="set-card">
          <div className="set-head"><Terminal size={15} /><div><div className="st">Ship an update</div><div className="ss">This app was published from your computer. To update it, run this in your project folder:</div></div></div>
          <div className="cmd-box">
            <code>{cmd}</code>
            <button className="ic-btn" title="Copy" onClick={() => navigator.clipboard?.writeText(cmd)}><Copy size={14} /></button>
          </div>
        </div>
      )}
    </>
  );
}
