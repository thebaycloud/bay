"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Search, Plus } from "lucide-react";
import { Bracket } from "@/components/Bracket";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Sidebar } from "@/components/Sidebar";

interface App { slug: string; name: string; url: string; ready: boolean; region: string; image: string; status?: string; stage?: string; }

export default function Home() {
  const [apps, setApps] = useState<App[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let stop = false;
    async function load() {
      try {
        const d = await (await fetch("/api/apps")).json();
        if (stop) return;
        if (d.error) setErr(d.error);
        setApps(d.apps ?? []);
        // Keep polling while any deploy is still building.
        if ((d.apps ?? []).some((a: App) => a.status === "building")) setTimeout(load, 3000);
      } catch (e) {
        if (!stop) { setErr(String(e)); setApps([]); }
      }
    }
    load();
    return () => { stop = true; };
  }, []);

  const live = (apps ?? []).filter((a) => a.ready).length;

  return (
    <div className="shell shell-side">
      <Sidebar active="apps" />
      <div className="main">
        <header className="topbar">
          <button className="kbar"><Search size={13} />Search<span className="kbd">⌘K</span></button>
          <div className="spacer" />
          <Bracket>
            <Link href="/new" className="btn primary"><Plus size={13} />New app</Link>
          </Bracket>
        </header>

        <div className="content">
        <div className="wrap">
          <div className="ruler reveal" />
          <section className="home-hero reveal" style={{ animationDelay: ".03s" }}>
            <div className="eyebrow">/ APPS</div>
            <h1>Your apps</h1>
            <div className="note">
              {apps === null ? "loading…" : `${apps.length} apps · ${live} live`}
              {err ? ` · ⚠ ${err.slice(0, 70)}` : ""}
            </div>
          </section>

          <section className="reveal" style={{ animationDelay: ".07s" }}>
            <div className="apps-grid">
              <Link href="/new" className="app-card new">
                <span className="plusbig">+</span>New app
              </Link>
              {(apps ?? []).map((a) => a.status === "building" ? (
                <Link key={a.slug} href={`/apps/${a.slug}?tab=deployments`} className="app-card building">
                  <div className="thumb"><span className="thumb-build">◐</span></div>
                  <div className="card-body">
                    <div className="r1">
                      <span className="nm">{a.name || a.slug}</span>
                      <span className="st building"><span className="d" />Building</span>
                    </div>
                    <div className="url">{a.stage}</div>
                  </div>
                </Link>
              ) : (
                <Link key={a.slug} href={`/apps/${a.slug}`} className="app-card">
                  <div className="thumb">
                    {a.url
                      ? <iframe src={`https://${a.slug}.supersonic.cv`} title={a.slug} loading="lazy" sandbox="allow-scripts allow-same-origin" />
                      : <span className="thumb-mono">{a.slug.charAt(0).toUpperCase()}</span>}
                  </div>
                  <div className="card-body">
                    <div className="r1">
                      <span className="nm">{a.name || a.slug}</span>
                      <span className={`st ${a.ready ? "live" : "error"}`}><span className="d" />{a.ready ? "Live" : "Down"}</span>
                    </div>
                    <div className="url">{a.slug}.supersonic.cv</div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        </div>
        </div>
      </div>

      <ThemeToggle />
    </div>
  );
}
