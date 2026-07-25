"use client";

import { useEffect, useState } from "react";

type Visibility = "private" | "shared" | "workspace";

const LABEL: Record<Visibility, string> = {
  private: "Only me",
  shared: "Specific people",
  workspace: "Everyone at my company",
};

export default function SharePanel({ slug }: { slug: string }) {
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [grants, setGrants] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const r = await fetch(`/api/apps/${slug}/share`);
    if (!r.ok) return;
    const j = await r.json();
    setVisibility(j.visibility);
    setGrants(j.grants ?? []);
  }
  useEffect(() => { load(); }, [slug]);

  async function post(body: Record<string, string>) {
    setBusy(true);
    const r = await fetch(`/api/apps/${slug}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      const j = await r.json();
      setVisibility(j.visibility);
      setGrants(j.grants ?? []);
    }
    setBusy(false);
  }

  return (
    <section className="space-y-3">
      <h2 className="text-sm uppercase tracking-wide opacity-60">Access</h2>

      <select
        value={visibility}
        disabled={busy}
        onChange={(e) => post({ visibility: e.target.value })}
        className="w-full rounded border border-white/15 bg-transparent p-2"
      >
        {(Object.keys(LABEL) as Visibility[]).map((v) => (
          <option key={v} value={v}>{LABEL[v]}</option>
        ))}
      </select>

      {visibility === "shared" && (
        <div className="space-y-2">
          <form
            onSubmit={(e) => { e.preventDefault(); if (email) { post({ addEmail: email }); setEmail(""); } }}
            className="flex gap-2"
          >
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@company.com"
              className="flex-1 rounded border border-white/15 bg-transparent p-2"
            />
            <button disabled={busy} className="rounded border border-white/15 px-3">Add</button>
          </form>
          <ul className="space-y-1 text-sm">
            {grants.map((g) => (
              <li key={g} className="flex items-center justify-between">
                <span>{g}</span>
                <button onClick={() => post({ removeEmail: g })} disabled={busy} className="opacity-60 hover:opacity-100">remove</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
