"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import {
  Zap, ChevronDown, LayoutGrid, Rocket, Database, Users, BarChart3, Mail,
  HardDrive, Globe, Server, GitBranch, Search, Copy, ArrowUpRight, RefreshCw,
  Check, Lock, ChevronRight, AlertTriangle,
} from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import { DatabasePanel } from "./DatabasePanel";
import { StoragePanel } from "./StoragePanel";
import { JobsPanel } from "./JobsPanel";
import { IssuesPanel } from "./IssuesPanel";

interface ServiceInfo {
  slug: string; name: string; url: string; ready: boolean; region: string;
  created: string; revision: string; image: string; envKeys: string[]; cloudsql: string; repo: string; storageBucket: string; owner: string;
}

const navServices = [
  { icon: Database, label: "Database" },
  { icon: Globe, label: "Domain" },
  { icon: Server, label: "Compute" },
  { icon: GitBranch, label: "Deployments" },
];

export function Cockpit({ appName, data }: { appName: string; data: ServiceInfo | null }) {
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

  // LEFT — what your app already has, in plain language (only the wired ones).
  const haves = [
    Boolean(d.url) && { icon: Lock, label: "Secure web address", desc: `${liveHost} · HTTPS is on` },
    hasDb && { icon: Database, label: "Database", desc: "Your app's data is saved and backed up" },
    hasStorage && { icon: HardDrive, label: "File uploads", desc: "Files stored and served fast worldwide" },
    { icon: Server, label: "Always online", desc: "Handles anything from 1 to millions of visitors" },
  ].filter(Boolean) as { icon: typeof Lock; label: string; desc: string }[];

  // RIGHT — things you can do to your app.
  const todos = [
    !hasDb && { icon: Database, label: "Add a database", desc: "Save your app's data" },
    !hasStorage && { icon: HardDrive, label: "Add file storage", desc: "Let people upload files" },
    { icon: Users, label: "Add user sign-in", desc: "Let people log into your app" },
    { icon: Mail, label: "Add email", desc: "Send welcome & reset emails" },
    { icon: BarChart3, label: "Turn on analytics", desc: "See who's visiting" },
  ].filter(Boolean) as { icon: typeof Lock; label: string; desc: string }[];

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
          <button className="nav-item active"><LayoutGrid size={15} />Overview</button>
          <button className="nav-item"><Rocket size={15} />Deployments</button>
          <div className="nav-label">Services</div>
          {navServices.map((s) => (<button className="nav-item" key={s.label}><s.icon size={15} />{s.label}</button>))}
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
          <button className="kbar"><Search size={13} />Search<span className="kbd">⌘K</span></button>
          <div className="url-pill">
            <span className="u">{liveHost}</span>
            <button className="ib" title="Copy" onClick={() => copy(liveHost, `${liveHost} copied`)}><Copy size={14} /></button>
            <a className="ib" title="Visit" href={liveUrl} target="_blank" rel="noreferrer"><ArrowUpRight size={14} /></a>
          </div>
          <div className="status" style={{ color: d.ready ? "var(--live)" : "var(--ink-2)", borderColor: d.ready ? "color-mix(in srgb, var(--live) 30%, var(--border))" : "var(--line-2)" }}>
            <span className="d" style={{ background: d.ready ? "var(--live)" : "var(--faint)" }} />{d.ready ? "Live" : "Down"}
          </div>
          {d.repo
            ? <Link href={`/new?repo=${encodeURIComponent(d.repo)}`} className="btn primary"><RefreshCw size={13} />Redeploy</Link>
            : <button className="btn" onClick={() => location.reload()}><RefreshCw size={13} />Refresh</button>}
        </header>

        <div className="content">
          <div className="wrap">
            <div className="ruler reveal" />

            <section className="cockpit-top reveal" style={{ animationDelay: ".03s" }}>
              {/* LEFT — your app */}
              <div className="ct-main">
                {Boolean(d.url) && (
                  <a className="preview" href={liveUrl} target="_blank" rel="noreferrer">
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
                  <p className="sub">{d.ready ? "Running smoothly on Cloud Run — nothing for you to babysit." : "This app is currently down. Check the to-do list for what to fix."}</p>
                </div>

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
                      <div className="row"><span className="k">source</span><span className="v">{d.repo ? d.repo.replace(/^https?:\/\//, "") : "—"}</span></div>
                      <div className="row"><span className="k">database</span><span className="v">{hasDb ? dbName : "none"}</span></div>
                      <div className="row"><span className="k">created</span><span className="v">{created}</span></div>
                    </div>
                    <div className="envchips">
                      <span className="envlabel">environment</span>
                      {d.envKeys.length === 0 && <span className="chip">no env vars set</span>}
                      {d.envKeys.map((k) => <span className="chip" key={k}>{k}</span>)}
                    </div>
                  </div>
                </details>
              </div>

              {/* RIGHT — to-do rail */}
              <aside className="ct-rail">
                <div className="rail-h">To-do</div>
                <a href="#issues" className="todo-item alert">
                  <span className="tic"><AlertTriangle size={15} /></span>
                  <div className="tgrow"><div className="tl">Check for issues</div><div className="td">Errors caught in production</div></div>
                  <ChevronRight size={15} className="tchev" />
                </a>
                {todos.map((t) => (
                  <button className="todo-item" key={t.label}>
                    <span className="tic"><t.icon size={15} /></span>
                    <div className="tgrow"><div className="tl">{t.label}</div><div className="td">{t.desc}</div></div>
                    <ChevronRight size={15} className="tchev" />
                  </button>
                ))}
              </aside>
            </section>

            <div id="issues"><IssuesPanel slug={appName} /></div>
            <DatabasePanel slug={appName} hasDb={hasDb} />
            <StoragePanel slug={appName} hasStorage={hasStorage} />
            <JobsPanel slug={appName} />
          </div>
        </div>
      </div>

      <ThemeToggle />
      <div className={"toast" + (toast ? " show" : "")}><Check size={13} /><span>{toast ?? ""}</span></div>
    </div>
  );
}
