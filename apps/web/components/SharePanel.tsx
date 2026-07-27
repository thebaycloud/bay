"use client";

import { useEffect, useState } from "react";
import { Lock, Users, Globe, Check, X } from "lucide-react";

type Visibility = "private" | "shared" | "public";

const OPTIONS: { id: Visibility; icon: typeof Lock; label: string; desc: string }[] = [
  { id: "private", icon: Lock, label: "Only me", desc: "Just you can open it" },
  { id: "shared", icon: Users, label: "Specific people", desc: "People you invite by email" },
  { id: "public", icon: Globe, label: "Public", desc: "Anyone with the link" },
];

export default function SharePanel({ slug }: { slug: string }) {
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [grants, setGrants] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const r = await fetch(`/api/apps/${slug}/share`);
      if (!r.ok) { setError(r.status === 403 ? "Only the owner can manage access" : `Couldn't load (${r.status})`); return; }
      const j = await r.json();
      setVisibility(j.visibility);
      setGrants(j.grants ?? []);
    } catch { setError("Couldn't load sharing settings"); }
  }
  useEffect(() => { load(); }, [slug]);

  async function post(body: Record<string, string>) {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/apps/${slug}/share`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error ?? `Couldn't save (${r.status})`); return; }
      setVisibility(j.visibility);
      setGrants(j.grants ?? []);
    } catch { setError("Couldn't reach the server"); }
    finally { setBusy(false); }
  }

  return (
    <div className="share-panel">
      {error && <div className="share-err">⚠ {error}</div>}

      <div className="share-opts">
        {OPTIONS.map((o) => (
          <button key={o.id} className={"share-opt" + (visibility === o.id ? " on" : "")} disabled={busy} onClick={() => post({ visibility: o.id })}>
            <span className="so-ic"><o.icon size={15} /></span>
            <span className="so-grow"><span className="so-l">{o.label}</span><span className="so-d">{o.desc}</span></span>
            {visibility === o.id && <Check size={15} className="so-check" />}
          </button>
        ))}
      </div>

      {visibility === "shared" && (
        <div className="share-people">
          <form className="share-add" onSubmit={(e) => { e.preventDefault(); if (email) { post({ addEmail: email }); setEmail(""); } }}>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@company.com" />
            <button className="btn sm" disabled={busy || !email}>Add</button>
          </form>
          {grants.length > 0 && (
            <ul className="share-grants">
              {grants.map((g) => (
                <li key={g}><span>{g}</span><button className="share-rm" disabled={busy} onClick={() => post({ removeEmail: g })}><X size={13} /></button></li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
