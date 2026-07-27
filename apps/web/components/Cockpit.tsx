"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Zap, ChevronDown, LayoutGrid, Database, HardDrive, Server, Copy,
  ArrowUpRight, RefreshCw, Check, Lock, AlertTriangle, Settings2, GitBranch,
} from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import { DatabasePanel } from "./DatabasePanel";
import { StoragePanel } from "./StoragePanel";
import { JobsPanel } from "./JobsPanel";
import { IssuesPanel } from "./IssuesPanel";
import { SettingsSection } from "./SettingsSection";
import { DeploymentsSection } from "./DeploymentsSection";

interface ServiceInfo {
  slug: string; name: string; url: string; ready: boolean; region: string;
  created: string; revision: string; image: string; envKeys: string[]; cloudsql: string; repo: string; storageBucket: string; owner: string;
}

type Tab = "overview" | "issues" | "data" | "deployments" | "settings";

const tabs: { id: Tab; icon: typeof LayoutGrid; label: string }[] = [
  { id: "overview", icon: LayoutGrid, label: "Overview" },
  { id: "issues", icon: AlertTriangle, label: "Issues" },
  { id: "data", icon: Database, label: "Data" },
  { id: "deployments", icon: GitBranch, label: "Deployments" },
  { id: "settings", icon: Settings2, label: "Settings" },
];

export function Cockpit({ appName, data, children }: { appName: string; data: ServiceInfo | null; children?: ReactNode }) {
  const d = data ?? { slug: appName, name: appName, url: "", ready: false, region: "us-central1", created: "", revision: "", image: "", envKeys: [], cloudsql: "", repo: "", storageBucket: "", owner: "" };
  const domain = `${appName}.supersonic.cv`;
  // The run.app URL works immediately; the custom subdomain needs SSL provisioning
  // (~15 min) and may not resolve yet — use the working URL for preview + links.
  const liveUrl = d.url || `https://${domain}`;
  const liveHost = liveUrl.replace(/^https?:\/\//, "");
  const displayName = d.name || appName;
  const hasDb = Boolean(d.cloudsql);
  const hasStorage = Boolean(d.storageBucket);
  const dbName = hasDb ? d.cloudsql.split(":").pop() ?? "attached" : "";
  const imageShort = d.image.split("/").pop() ?? "";
  const created = d.created ? d.created.slice(0, 10) : "—";

  const haves = [
    Boolean(d.url) && { icon: Lock, label: "Secure web address", desc: `${liveHost} · HTTPS is on` },
    hasDb && { icon: Database, label: "Database", desc: "Your app's data is saved and backed up" },
    hasStorage && { icon: HardDrive, label: "File uploads", desc: "Files stored and served fast worldwide" },
    { icon: Server, label: "Always online", desc: "Handles anything from 1 to millions of visitors" },
  ].filter(Boolean) as { icon: typeof Lock; label: string; desc: string }[];

  const [tab, setTab] = useState<Tab>("overview");
  // Deep-link: /apps/<slug>?tab=deployments (used by the dashboard's Building card).
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t && tabs.some((x) => x.id === t)) setTab(t as Tab);
  }, []);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }
  function copy(text: string, msg: string) { navigator.clipboard?.writeText(text).catch(() => {}); showToast(msg); }

  return (
    <div className="app">
      <aside className="sidebar">
        <Link href="/" className="brand" style={{ textDecoration: "none", color: "inherit" }}>
          <span className="logo"><Zap size={13} strokeWidth={2.4} /></span>
          SUPERSONIC
        </Link>
        <button className="switch">
          <span className="dot" style={{ background: d.ready ? "var(--live)" : "var(--faint)" }} />
          <span className="nm">{displayName}</span>
          <ChevronDown className="chev" size={13} />
        </button>
        <nav>
          {tabs.map((t) => (
            <button key={t.id} className={"nav-item" + (tab === t.id ? " active" : "")} onClick={() => setTab(t.id)}>
              <t.icon size={15} />{t.label}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <div className="av">A</div>
          <div><div className="mn">amir</div><div className="mp">Pro · burning credits</div></div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="crumb">
            <Link href="/" className="c-dim" style={{ textDecoration: "none", color: "inherit" }}>apps</Link>
            <span className="sep">/</span><span>{displayName}</span>
          </div>
          <div className="spacer" />
          <div className="url-pill">
            <span className="u">{liveHost}</span>
            <button className="ib" title="Copy" onClick={() => copy(liveHost, `${liveHost} copied`)}><Copy size={14} /></button>
            <a className="ib" title="Visit" href={liveUrl} target="_blank" rel="noreferrer"><ArrowUpRight size={14} /></a>
          </div>
          <div className="status" style={{ color: d.ready ? "var(--live)" : "var(--ink-2)", borderColor: d.ready ? "color-mix(in srgb, var(--live) 30%, var(--border))" : "var(--line-2)" }}>
            <span className="d" style={{ background: d.ready ? "var(--live)" : "var(--faint)" }} />{d.ready ? "Live" : "Down"}
          </div>
          <button className="btn primary" onClick={() => setTab("deployments")}><RefreshCw size={13} />Redeploy</button>
        </header>

        <div className="content">
          <div className="wrap">
            <div className="ruler reveal" />

            {tab === "overview" && (
              <section className="section-page reveal">
                {Boolean(d.url) && (
                  <a className="preview wide" href={liveUrl} target="_blank" rel="noreferrer">
                    <div className="bar">
                      <span className="dots"><i /><i /><i /></span>
                      <span className="pu">{liveHost}</span>
                      <ArrowUpRight size={13} className="ext" />
                    </div>
                    <div className="frame">
                      <iframe src={liveUrl} title={`${appName} preview`} loading="lazy" sandbox="allow-scripts allow-same-origin allow-forms" />
                      <span className="frame-hint">live preview — click to open</span>
                    </div>
                  </a>
                )}

                <div className="ct-head">
                  <div className="eyebrow">
                    <span className="live"><span className="d" style={{ background: d.ready ? "var(--live)" : "var(--faint)" }} />{d.ready ? "LIVE" : "DOWN"}</span>
                    <span>/ YOUR APP</span>
                  </div>
                  <h1>{displayName}</h1>
                  <p className="sub">{d.ready ? "Running smoothly on Cloud Run — nothing for you to babysit." : "This app is currently down. Check Issues for what to fix."}</p>
                </div>

                {children && <div className="ov-share">{children}</div>}

                <div className="haves">
                  <div className="haves-h">What your app has</div>
                  {haves.map((h) => (
                    <div className="have" key={h.label}>
                      <span className="hic"><h.icon size={15} /></span>
                      <div className="hgrow"><div className="hl">{h.label}</div><div className="hd">{h.desc}</div></div>
                      <Check size={15} className="hchk" />
                    </div>
                  ))}
                </div>

                <details className="techdet">
                  <summary>Technical details<ChevronDown size={14} /></summary>
                  <div className="techbody">
                    <div className="kv">
                      <div className="row"><span className="k">status</span><span className="v">{d.ready ? "serving 100%" : "not ready"}</span></div>
                      <div className="row"><span className="k">revision</span><span className="v">{d.revision || "—"}</span></div>
                      <div className="row"><span className="k">region</span><span className="v">{d.region}</span></div>
                      <div className="row"><span className="k">image</span><span className="v">{imageShort || "—"}</span></div>
                      <div className="row"><span className="k">source</span><span className="v">{d.repo ? d.repo.replace(/^https?:\/\//, "") : "from your computer"}</span></div>
                      <div className="row"><span className="k">database</span><span className="v">{hasDb ? dbName : "none"}</span></div>
                      <div className="row"><span className="k">created</span><span className="v">{created}</span></div>
                    </div>
                  </div>
                </details>
              </section>
            )}

            {tab === "issues" && (
              <section className="section-page reveal">
                <div className="page-head"><h2>Issues</h2><p>Errors caught in production. We never touch your code — you get a paste-ready fix for your coding agent.</p></div>
                <IssuesPanel slug={appName} />
              </section>
            )}

            {tab === "data" && (
              <section className="section-page reveal">
                <div className="page-head"><h2>Data</h2><p>Your app&apos;s database, files, and scheduled tasks.</p></div>
                <DatabasePanel slug={appName} hasDb={hasDb} />
                <StoragePanel slug={appName} hasStorage={hasStorage} />
                <JobsPanel slug={appName} />
              </section>
            )}

            {tab === "deployments" && (
              <section className="section-page reveal">
                <DeploymentsSection slug={appName} repo={d.repo} />
              </section>
            )}

            {tab === "settings" && (
              <section className="section-page reveal">
                <SettingsSection slug={appName} name={displayName} liveHost={liveHost} envKeys={d.envKeys} onToast={showToast} />
              </section>
            )}
          </div>
        </div>
      </div>

      <ThemeToggle />
      <div className={"toast" + (toast ? " show" : "")}><Check size={13} /><span>{toast ?? ""}</span></div>
    </div>
  );
}
