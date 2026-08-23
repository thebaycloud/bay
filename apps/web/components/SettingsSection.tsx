"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, KeyRound, Globe, AlertTriangle, Loader2 } from "lucide-react";
import { DomainsPanel } from "./DomainsPanel";
import { GitPanel } from "./GitPanel";

export function SettingsSection({
  slug, name, liveHost, envKeys, onToast,
}: { slug: string; name: string; liveHost: string; envKeys: string[]; onToast: (m: string) => void }) {
  const router = useRouter();

  // --- Environment ---
  const [keys, setKeys] = useState<string[]>(envKeys);
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const [envBusy, setEnvBusy] = useState(false);
  const [envErr, setEnvErr] = useState("");

  useEffect(() => {
    fetch(`/api/apps/${slug}/env`).then((r) => r.json()).then((d) => { if (d.keys) setKeys(d.keys); }).catch(() => {});
  }, [slug]);

  async function addVar() {
    if (!newKey.trim() || !newVal) return;
    setEnvBusy(true); setEnvErr("");
    const r = await (await fetch(`/api/apps/${slug}/env`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ set: { [newKey.trim()]: newVal } }),
    })).json();
    setEnvBusy(false);
    if (r.error) { setEnvErr(r.error); return; }
    setKeys(r.keys ?? keys); setNewKey(""); setNewVal("");
    onToast(`${newKey.trim()} saved — new version rolling out`);
  }
  async function removeVar(k: string) {
    setEnvBusy(true); setEnvErr("");
    const r = await (await fetch(`/api/apps/${slug}/env`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unset: [k] }),
    })).json();
    setEnvBusy(false);
    if (r.error) { setEnvErr(r.error); return; }
    setKeys(r.keys ?? keys.filter((x) => x !== k));
    onToast(`${k} removed — new version rolling out`);
  }

  // --- Delete ---
  const [confirm, setConfirm] = useState("");
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState("");
  async function del() {
    setDelBusy(true); setDelErr("");
    const r = await (await fetch(`/api/apps/${slug}/delete`, { method: "POST" })).json();
    if (r.error) { setDelErr(r.error); setDelBusy(false); return; }
    onToast(`${name} deleted`);
    router.push("/"); router.refresh();
  }

  return (
    <>
      <div className="page-head"><h2>Settings</h2><p>Environment variables, your app&apos;s address, and deleting the app.</p></div>

      {/* Environment */}
      <div className="set-card">
        <div className="set-head"><KeyRound size={15} /><div><div className="st">Environment variables</div><div className="ss">Secrets and config your app reads. Values stay hidden. Saving redeploys your app.</div></div></div>
        <div className="env-list">
          {keys.length === 0 && <div className="env-empty">No environment variables yet.</div>}
          {keys.map((k) => (
            <div className="env-row" key={k}>
              <span className="ek">{k}</span>
              <span className="ev">••••••••</span>
              <button className="ic-btn" title="Remove" disabled={envBusy} onClick={() => removeVar(k)}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
        <div className="env-add">
          <input className="in mono" placeholder="KEY" value={newKey} onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))} />
          <input className="in mono" placeholder="value" type="password" value={newVal} onChange={(e) => setNewVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addVar(); }} />
          <button className="btn primary" disabled={envBusy || !newKey.trim() || !newVal} onClick={addVar}>
            {envBusy ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}Add
          </button>
        </div>
        {envErr && <div className="set-err">⚠ {envErr}</div>}
      </div>

      {/* Domain */}
      <div className="set-card">
        <div className="set-head"><Globe size={15} /><div><div className="st">Address</div><div className="ss">Where people reach your app.</div></div></div>
        <div className="dom-row">
          <div className="dom-one">
            <span className="dom-lbl">Supersonic address</span>
            <div className="dom-line"><span className="dom-val mono">{liveHost}</span><span className="dom-ok">✓ live</span></div>
          </div>
        </div>
        <DomainsPanel slug={slug} onToast={onToast} />
      </div>

      {/* Source. Draws nothing at all when no repository is connected — an app
          deployed from a folder has no connection to show, and an empty card
          offering to make one would be a worse copy of the door on /new. */}
      <GitPanel slug={slug} onToast={onToast} />

      {/* Danger zone */}
      <div className="set-card danger">
        <div className="set-head"><AlertTriangle size={15} /><div><div className="st">Delete this app</div><div className="ss">Permanently removes {name}, its database, files, and address. This can&apos;t be undone.</div></div></div>
        <div className="danger-confirm">
          <input className="in mono" placeholder={`type "${name}" to confirm`} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <button className="btn danger-btn" disabled={confirm !== name || delBusy} onClick={del}>
            {delBusy ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />}Delete app
          </button>
        </div>
        {delErr && <div className="set-err">⚠ {delErr}</div>}
      </div>
    </>
  );
}
