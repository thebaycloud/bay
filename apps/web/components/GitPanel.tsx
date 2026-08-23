"use client";

import { useCallback, useEffect, useState } from "react";
import { Github, Loader2, Check, Unlink } from "lucide-react";

/**
 * The repository this app follows, from the person's side.
 *
 * One claim and one switch. The claim — "every push to this branch ships your
 * app" — is the whole feature, so it is stated in those words rather than
 * implied by a checkbox labelled *auto deploy*; a person who reads only this
 * panel should be able to predict exactly what their next `git push` does.
 *
 * Draws nothing at all when no repository is connected. An app deployed from a
 * folder or a public URL has no connection to show, and an empty card offering
 * to connect one would be a second, worse copy of the GitHub door on /new — the
 * connection is made there, where the repositories already are.
 */

interface Link {
  connected: boolean;
  repo?: string;
  branch?: string;
  autoDeploy?: boolean;
  url?: string;
}

export function GitPanel({ slug, onToast }: { slug: string; onToast: (m: string) => void }) {
  const [link, setLink] = useState<Link | null>(null);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const d = (await (await fetch(`/api/apps/${slug}/git`)).json()) as Link;
      setLink(d);
      if (d.branch) setBranch(d.branch);
    } catch {
      // A page that cannot reach the API shows what it last knew, and shows
      // nothing on a first load rather than an error about our own network.
    }
  }, [slug]);

  useEffect(() => { void load(); }, [load]);

  async function save(body: Record<string, unknown>, said: string) {
    setBusy(true); setErr("");
    try {
      const res = await fetch(`/api/apps/${slug}/git`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) { setErr(d.error || "That didn't save."); return; }
      setLink(d); setBranch(d.branch ?? ""); onToast(said);
    } catch {
      setErr("That didn't save. Try again in a moment.");
    } finally { setBusy(false); }
  }

  async function disconnect() {
    setBusy(true); setErr("");
    try {
      await fetch(`/api/apps/${slug}/git`, { method: "DELETE" });
      setLink({ connected: false });
      // Said in full, because the thing that stops is not the thing a person
      // might fear stopping: the app keeps running and keeps its address.
      onToast("Disconnected. Your app keeps running — pushes just won't ship it.");
    } catch {
      setErr("That didn't save. Try again in a moment.");
    } finally { setBusy(false); }
  }

  if (!link?.connected) return null;

  const on = link.autoDeploy !== false;
  const changed = branch.trim() !== "" && branch.trim() !== link.branch;

  return (
    <div className="set-card">
      <div className="set-head">
        <Github size={15} />
        <div>
          <div className="st">Source</div>
          <div className="ss">Where this app&apos;s code comes from, and what a push to it does.</div>
        </div>
      </div>
      <div className="dom-custom" style={{ borderTop: "none" }}>
      <div className="dom-item">
        <Github size={14} />
        <a className="dom-host mono" href={link.url} target="_blank" rel="noreferrer">{link.repo}</a>
        {on
          ? <span className="dom-state ok"><Check size={12} />Ships on push</span>
          : <span className="dom-state">Paused</span>}
      </div>

      <div className="dom-add">
        <input
          className="in mono"
          value={branch}
          disabled={busy}
          onChange={(e) => setBranch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && changed) void save({ branch: branch.trim() }, `Now shipping from ${branch.trim()}.`); }}
          placeholder="main"
          aria-label="Branch"
        />
        <button
          className="btn primary"
          disabled={busy || !changed}
          onClick={() => void save({ branch: branch.trim() }, `Now shipping from ${branch.trim()}.`)}
        >
          {busy ? <Loader2 size={13} className="spin" /> : null}Change branch
        </button>
      </div>

      <p className="dom-note">
        {on
          ? <>Every push to <span className="mono">{link.branch}</span> ships this app.</>
          : <>Pushes to <span className="mono">{link.branch}</span> are ignored until you turn this back on.</>}
      </p>

      <div className="dom-add">
        <button
          className="btn"
          disabled={busy}
          onClick={() => void save({ autoDeploy: !on }, on ? "Pushes won't ship this app any more." : "Pushes will ship this app again.")}
        >{on ? "Pause shipping on push" : "Ship on push again"}</button>
        <button className="btn" disabled={busy} onClick={() => void disconnect()}>
          <Unlink size={13} />Disconnect
        </button>
      </div>

      {err && <div className="set-err">⚠ {err}</div>}
      </div>
    </div>
  );
}
