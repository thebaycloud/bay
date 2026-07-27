"use client";

import { useEffect, useState } from "react";

type Visibility = "private" | "shared" | "public";

const LABEL: Record<Visibility, string> = {
  private: "Only me",
  shared: "Specific people",
  public: "Public — anyone with the link",
};

export default function SharePanel({ slug }: { slug: string }) {
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [grants, setGrants] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const r = await fetch(`/api/apps/${slug}/share`);
      if (!r.ok) {
        setError(r.status === 403 ? "Only the owner can manage access" : `Couldn't load sharing settings (${r.status})`);
        return;
      }
      const j = await r.json();
      setVisibility(j.visibility);
      setGrants(j.grants ?? []);
    } catch {
      setError("Couldn't load sharing settings");
    }
  }
  useEffect(() => { load(); }, [slug]);

  async function post(body: Record<string, string>) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/apps/${slug}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j.error ?? `Couldn't save (${r.status})`);
        return;
      }
      setVisibility(j.visibility);
      setGrants(j.grants ?? []);
    } catch {
      // Without this the controls stay disabled forever on a dropped network.
      setError("Couldn't reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-sm uppercase tracking-wide opacity-60">Access</h2>

      {error && <p className="text-sm text-red-400">{error}</p>}

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
