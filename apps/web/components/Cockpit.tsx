"use client";

import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import {
  Zap, ChevronDown, LayoutGrid, Rocket, Database, Users, BarChart3, Mail,
  HardDrive, ShieldCheck, Globe, History, Server, GitBranch, Search, Copy,
  ArrowUpRight, RefreshCw, Check,
} from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import { DatabasePanel } from "./DatabasePanel";
import { StoragePanel } from "./StoragePanel";
import { JobsPanel } from "./JobsPanel";
import { IssuesPanel } from "./IssuesPanel";

interface ServiceInfo {
  slug: string; url: string; ready: boolean; region: string;
  created: string; revision: string; image: string; envKeys: string[]; cloudsql: string; repo: string; storageBucket: string; owner: string;
}

const services = [
  { icon: Database, label: "Database" },
  { icon: Globe, label: "Domain" },
  { icon: Server, label: "Compute" },
  { icon: GitBranch, label: "Deployments" },
];

export function Cockpit({ appName, data, children }: { appName: string; data: ServiceInfo | null; children?: ReactNode }) {
  const d = data ?? { slug: appName, url: "", ready: false, region: "us-central1", created: "", revision: "", image: "", envKeys: [], cloudsql: "", repo: "", storageBucket: "", owner: "" };
  const domain = `${appName}.supersonic.cv`;
  const hasDb = Boolean(d.cloudsql);
  const hasStorage = Boolean(d.storageBucket);
  const dbName = hasDb ? d.cloudsql.split(":").pop() ?? "attached" : "";
  const revShort = d.revision.replace(`${appName}-`, "") || "—";
  const imageShort = d.image.split("/").pop() ?? "";
  const created = d.created ? d.created.slice(0, 10) : "—";

  const batteries = [
    { icon: Database, name: "Database", wired: hasDb, stat: hasDb ? "Postgres · attached" : "not attached", meta: hasDb ? dbName : "no database detected" },
    { icon: Globe, name: "Domain", wired: Boolean(d.url), stat: domain, meta: "Cloud Run · auto-SSL" },
    { icon: Server, name: "Compute", wired: true, stat: `Cloud Run · ${d.region}`, meta: "scale-to-zero" },
    { icon: GitBranch, name: "Deployment", wired: Boolean(d.revision), stat: revShort, meta: "latest ready revision" },
    { icon: Users, name: "Auth", wired: false, stat: "not set up", meta: "Identity Platform" },
    { icon: Mail, name: "Email", wired: false, stat: "not set up", meta: "transactional" },
    { icon: HardDrive, name: "Storage", wired: hasStorage, stat: hasStorage ? "GCS bucket" : "not set up", meta: hasStorage ? d.storageBucket : "GCS + CDN" },
    { icon: BarChart3, name: "Analytics", wired: false, stat: "not set up", meta: "PostHog" },
  ];

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
          <span className="nm">{appName}</span>
          <ChevronDown className="chev" size={13} />
        </button>
        <nav>
          <button className="nav-item active"><LayoutGrid size={15} />Overview</button>
          <button className="nav-item"><Rocket size={15} />Deployments</button>
          <div className="nav-label">Services</div>
          {services.map((s) => (<button className="nav-item" key={s.label}><s.icon size={15} />{s.label}</button>))}
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
            <span className="sep">/</span><span>{appName}</span>
          </div>
          <div className="spacer" />
          <button className="kbar"><Search size={13} />Search<span className="kbd">⌘K</span></button>
          <div className="url-pill">
            <span className="u">{domain}</span>
            <button className="ib" title="Copy" onClick={() => copy(domain, `${domain} copied`)}><Copy size={14} /></button>
            <a className="ib" title="Visit" href={`https://${domain}`} target="_blank" rel="noreferrer"><ArrowUpRight size={14} /></a>
          </div>
          <div className="status" style={{ color: d.ready ? "var(--live)" : "var(--ink-2)", borderColor: d.ready ? "color-mix(in srgb, var(--live) 30%, var(--border))" : "var(--line-2)" }}>
            <span className="d" style={{ background: d.ready ? "var(--live)" : "var(--faint)" }} />{d.ready ? "Live" : "Down"}
          </div>
          {d.repo
            ? <Link href={`/new?repo=${encodeURIComponent(d.repo)}`} className="btn"><RefreshCw size={13} />Redeploy</Link>
            : <button className="btn" onClick={() => location.reload()}><RefreshCw size={13} />Refresh</button>}
        </header>

        <div className="content">
          <div className="wrap">
            <div className="ruler reveal" />

            <section className="hero reveal" style={{ animationDelay: ".03s" }}>
              <div className="hero-l">
                <div className="eyebrow">
                  <span className="live"><span className="d" style={{ background: d.ready ? "var(--live)" : "var(--faint)" }} />{d.ready ? "LIVE" : "DOWN"}</span>
                  <span>/ OVERVIEW</span>
                </div>
                <h1>{appName}</h1>
                <p className="sub">{data ? "Deployed to Cloud Run via Supersonic." : "Couldn't load live data — your gcloud session may need reauth."}</p>
                <div className="tags">
                  <span>CLOUD RUN</span>
                  <span>{d.region.toUpperCase()}</span>
                  {imageShort && <span>{imageShort.slice(0, 22)}</span>}
                </div>
              </div>
              <div className="hero-r">
                <div className="facts">
                  <div className="f"><span className="l">Status</span><span className="v">{d.ready ? "Live" : "Down"}</span></div>
                  <div className="f"><span className="l">Revision</span><span className="v">{revShort}</span></div>
                  <div className="f"><span className="l">Created</span><span className="v">{created}</span></div>
                </div>
              </div>
            </section>

            <section className="section reveal" style={{ animationDelay: ".07s" }}>
              <div className="section-head">
                <span className="idx">01</span>
                <h2>Services</h2>
                <span className="note">what&apos;s wired to this app</span>
              </div>
              <div className="grid-wrap">
                <div className="batteries">
                  {batteries.map((b) => (
                    <div className={"bat" + (b.wired ? "" : " off")} key={b.name}>
                      <div className="top">
                        <span className="ic"><b.icon size={14} /></span>
                        <span className="nm">{b.name}</span>
                        <span className="check">{b.wired ? "✓" : "—"}</span>
                      </div>
                      <div className="stat">{b.stat}</div>
                      <div className="meta">{b.meta}</div>
                    </div>
                  ))}
                </div>
                <span className="plus" style={{ left: "25%", top: "50%" }}>+</span>
                <span className="plus" style={{ left: "50%", top: "50%" }}>+</span>
                <span className="plus" style={{ left: "75%", top: "50%" }}>+</span>
              </div>
            </section>

            <DatabasePanel slug={appName} hasDb={hasDb} />

            <StoragePanel slug={appName} hasStorage={hasStorage} />

            <JobsPanel slug={appName} />

            <IssuesPanel slug={appName} />

            {children && (
              <section className="section reveal" style={{ animationDelay: ".13s" }}>
                <div style={{ padding: "20px 28px", maxWidth: 420 }}>{children}</div>
              </section>
            )}

            <section className="section reveal" style={{ animationDelay: ".11s" }}>
              <div className="split">
                <div className="panel">
                  <div className="p-head"><span className="t"><span className="d" style={{ background: d.ready ? "var(--live)" : "var(--faint)" }} />Deployment</span></div>
                  <div className="kv">
                    <div className="row"><span className="k">status</span><span className="v">{d.ready ? "serving 100%" : "not ready"}</span></div>
                    <div className="row"><span className="k">url</span><span className="v">{domain}</span></div>
                    <div className="row"><span className="k">region</span><span className="v">{d.region}</span></div>
                    <div className="row"><span className="k">revision</span><span className="v">{d.revision || "—"}</span></div>
                    <div className="row"><span className="k">image</span><span className="v">{imageShort || "—"}</span></div>
                    <div className="row"><span className="k">database</span><span className="v">{hasDb ? dbName : "none"}</span></div>
                    <div className="row"><span className="k">created</span><span className="v">{created}</span></div>
                  </div>
                </div>

                <div className="panel">
                  <div className="p-head"><span className="t"><span className="d" />Environment</span><span className="spacer" /><span className="tag">values hidden</span></div>
                  <div className="envchips">
                    {d.envKeys.length === 0 && <span className="chip">no env vars set</span>}
                    {d.envKeys.map((k) => <span className="chip" key={k}>{k}</span>)}
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>

      <ThemeToggle />
      <div className={"toast" + (toast ? " show" : "")}><Check size={13} /><span>{toast ?? ""}</span></div>
    </div>
  );
}
