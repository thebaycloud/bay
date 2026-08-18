"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Clock, Loader2, Plus, Trash2 } from "lucide-react";

/**
 * Connecting a domain, from the person's side.
 *
 * Two things this panel refuses to do, both learned from what the state machine
 * behind it can honestly say:
 *
 *  - It never claims a domain is live because we created a certificate. `live`
 *    means Google is serving that certificate, which is the only version of the
 *    claim a browser will agree with.
 *  - It never shows a bare spinner. Every waiting state carries what it is
 *    waiting for, because "waiting for DNS" and "you pointed it somewhere else"
 *    look identical otherwise, and only one of them is something to act on.
 */

type Status = "pending_dns" | "securing" | "live" | "failed";

interface Domain {
  hostname: string;
  status: Status;
  detail: string | null;
  checkedAt: number | null;
  liveAt: number | null;
}

interface Dns { ip: string; cname: string }

/** How the four states read to a person. Platform words never appear here. */
const SAID: Record<Status, { label: string; tone: "wait" | "ok" | "bad" }> = {
  pending_dns: { label: "Waiting for your DNS", tone: "wait" },
  securing: { label: "Getting a certificate", tone: "wait" },
  live: { label: "Live", tone: "ok" },
  failed: { label: "Couldn't get a certificate", tone: "bad" },
};

export function DomainsPanel({ slug, onToast }: { slug: string; onToast: (m: string) => void }) {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [dns, setDns] = useState<Dns | null>(null);
  const [allowed, setAllowed] = useState(true);
  const [visibility, setVisibility] = useState("public");
  const [loaded, setLoaded] = useState(false);
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await (await fetch(`/api/apps/${slug}/domains`)).json();
      if (d.error) return;
      setDomains(d.domains ?? []);
      setDns(d.dns ?? null);
      setAllowed(d.allowed !== false);
      setVisibility(d.visibility ?? "public");
    } catch { /* a page that cannot reach the API shows what it last knew */ }
    finally { setLoaded(true); }
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  // Poll only while something is still moving. Reading the list is also what
  // advances it (see lib/domain-attach.ts), so this is the loop that carries a
  // domain from "written down" to "live" while the person watches — and it stops
  // the moment there is nothing left to watch.
  useEffect(() => {
    if (!loaded) return;
    const moving = domains.some((d) => d.status !== "live" && d.status !== "failed");
    if (!moving) return;
    // Just over the server's own recheck window (RECHECK_MS in lib/domain-attach),
    // so every poll is a poll that can actually learn something.
    timer.current = setTimeout(load, 12_000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [domains, loaded, load]);

  async function add() {
    const typed = host.trim();
    if (!typed) return;
    setBusy(true); setErr("");
    try {
      const r = await (await fetch(`/api/apps/${slug}/domains`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostname: typed }),
      })).json();
      if (r.error) { setErr(r.error); return; }
      setHost("");
      onToast(`${r.domain.hostname} added — point its DNS here and it goes live on its own`);
      await load();
    } finally { setBusy(false); }
  }

  async function remove(hostname: string) {
    setBusy(true); setErr("");
    try {
      const r = await (await fetch(`/api/apps/${slug}/domains?hostname=${encodeURIComponent(hostname)}`, {
        method: "DELETE",
      })).json();
      if (r.error) { setErr(r.error); return; }
      onToast(`${hostname} removed`);
      await load();
    } finally { setBusy(false); }
  }

  const waiting = domains.some((d) => d.status !== "live");

  return (
    <div className="dom-custom">
      <span className="dom-lbl">Your own domain</span>

      {domains.length > 0 && (
        <div className="dom-list">
          {domains.map((d) => {
            const said = SAID[d.status] ?? SAID.pending_dns;
            return (
              <div className="dom-item" key={d.hostname}>
                <span className="dom-host mono">{d.hostname}</span>
                <span className={`dom-state ${said.tone}`}>
                  {said.tone === "ok" ? <Check size={13} /> : said.tone === "bad" ? <AlertTriangle size={13} /> : <Clock size={13} />}
                  {said.label}
                </span>
                <button className="ic-btn" title="Remove" disabled={busy} onClick={() => remove(d.hostname)}>
                  <Trash2 size={14} />
                </button>
                {d.detail && d.status !== "live" && <div className="dom-detail">{d.detail}</div>}
              </div>
            );
          })}
        </div>
      )}

      {allowed ? (
        <>
          <div className="dom-add">
            <input
              className="in mono" placeholder="yourapp.com" value={host} disabled={busy}
              onChange={(e) => setHost(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            />
            <button className="btn primary" disabled={busy || !host.trim()} onClick={add}>
              {busy ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}Connect
            </button>
          </div>
          {err && <div className="set-err">⚠ {err}</div>}

          {/* Shown while anything is still waiting, and after adding — this is
              the one place the records a person has to create are written down,
              so it cannot be behind a state they have already left. */}
          {dns && (domains.length === 0 || waiting) && (
            <div className="dom-dns">
              <div className="dom-rec">
                <span className="dom-rec-k mono">CNAME</span>
                <span className="dom-rec-v mono">{dns.cname}</span>
                <span className="dom-rec-w">for a subdomain — shop.yourapp.com</span>
              </div>
              <div className="dom-rec">
                <span className="dom-rec-k mono">A</span>
                <span className="dom-rec-v mono">{dns.ip}</span>
                <span className="dom-rec-w">for the domain itself — yourapp.com</span>
              </div>
              <span className="dom-note">
                HTTPS turns on by itself, usually within ten minutes of the record going live.
                Nothing to redeploy.
              </span>
            </div>
          )}

          {visibility !== "public" && (
            <span className="dom-note">
              This app is {visibility}, so visitors on your domain are sent to {slug}.supersonic.cv to sign in —
              sign-in only works at that address. Make the app public to have your domain answer for it.
            </span>
          )}
        </>
      ) : (
        <span className="dom-note">
          Custom domains are on Pro. Your app keeps its supersonic.cv address — upgrade to point your own domain at it.
        </span>
      )}
    </div>
  );
}
