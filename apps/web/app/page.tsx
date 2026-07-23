"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Zap, Search, Plus } from "lucide-react";
import { Bracket } from "@/components/Bracket";
import { ThemeToggle } from "@/components/ThemeToggle";
import { UserMenu } from "@/components/UserMenu";

interface App { slug: string; url: string; ready: boolean; region: string; image: string; }

export default function Home() {
  const [apps, setApps] = useState<App[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/apps")
      .then((r) => r.json())
      .then((d) => { if (d.error) setErr(d.error); setApps(d.apps ?? []); })
      .catch((e) => { setErr(String(e)); setApps([]); });
  }, []);

  const live = (apps ?? []).filter((a) => a.ready).length;

  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="topbrand">
          <span className="logo"><Zap size={13} strokeWidth={2.4} /></span>
          SUPERSONIC
        </Link>
        <div className="spacer" />
        <button className="kbar"><Search size={13} />Search<span className="kbd">⌘K</span></button>
        <UserMenu />
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
              {(apps ?? []).map((a) => (
                <Link key={a.slug} href={`/apps/${a.slug}`} className="app-card">
                  <div className="r1">
                    <span className="nm">{a.slug}</span>
                    <span className={`st ${a.ready ? "live" : "error"}`}><span className="d" />{a.ready ? "Live" : "Down"}</span>
                  </div>
                  <div className="url">{a.url.replace(/^https?:\/\//, "") || "—"}</div>
                  <div className="fw"><span className="tag">Cloud Run</span></div>
                  <div className="meta">{a.region}</div>
                </Link>
              ))}
            </div>
          </section>
        </div>
      </div>

      <ThemeToggle />
    </div>
  );
}
