"use client";

import { useEffect, useState } from "react";
import { TriangleAlert, Copy, Wand2 } from "lucide-react";

interface Err { message: string; time: string; }

export function IssuesPanel({ slug }: { slug: string }) {
  const [errors, setErrors] = useState<Err[] | null>(null);
  const [err, setErr] = useState("");
  const [fixing, setFixing] = useState<number | null>(null);
  const [fix, setFix] = useState<{ i: number; prompt: string } | null>(null);
  const [toast, setToast] = useState("");

  useEffect(() => {
    fetch(`/api/apps/${slug}/errors`)
      .then((r) => r.json())
      .then((d) => { if (d.error) setErr(d.error); setErrors(d.errors || []); })
      .catch((e) => { setErr(String(e)); setErrors([]); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function getFix(i: number, message: string) {
    setFixing(i); setFix(null); setErr("");
    const r = await (await fetch(`/api/apps/${slug}/fix`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: message }) })).json();
    setFixing(null);
    if (r.error) { setErr(r.error); return; }
    setFix({ i, prompt: r.fixPrompt });
  }
  function copy(t: string) { navigator.clipboard?.writeText(t); setToast("Fix prompt copied — paste into Claude Code"); setTimeout(() => setToast(""), 2500); }

  return (
    <section className="section reveal" style={{ animationDelay: ".13s" }}>
      <div className="section-head"><span className="idx">05</span><h2>Issues</h2><span className="note">caught in production · Cloud Logging · we never touch your code</span></div>
      <div className="issues">
        {errors === null && !err && <div className="db-empty">loading…</div>}
        {err && <div className="db-empty">⚠ {err.slice(0, 140)}</div>}
        {errors && errors.length === 0 && !err && <div className="db-empty">no errors in the last 7 days — all healthy ✓</div>}
        {errors?.map((e, i) => (
          <div className="issue" key={i}>
            <div className="issue-head">
              <span className="ib"><TriangleAlert size={13} /></span>
              <span className="imsg">{e.message}</span>
              <button className="btn sm" disabled={fixing === i} onClick={() => getFix(i, e.message)}>
                <Wand2 size={12} />{fixing === i ? "analyzing…" : "Get the fix"}
              </button>
            </div>
            {fix && fix.i === i && (
              <div className="issue-fix">
                <div className="prompt-box"><div className="inner">{fix.prompt}</div></div>
                <div className="fix-foot">
                  <button className="btn primary sm" onClick={() => copy(fix.prompt)}><Copy size={12} />Copy fix prompt</button>
                  <span className="hint">paste into your coding agent</span>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className={"toast" + (toast ? " show" : "")}><span>{toast}</span></div>
    </section>
  );
}
