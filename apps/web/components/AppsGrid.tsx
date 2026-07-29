"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export interface App {
  slug: string; name: string; url: string; ready: boolean;
  region: string; image: string; status?: string; stage?: string;
  /** A screenshot captured at deploy time; absent until that pipeline exists. */
  thumbnail?: string;
}

/**
 * The app grid, handed its data by the server.
 *
 * The page used to be a client component that fetched in useEffect, so the order
 * was: HTML, then 449 kB of JavaScript, then hydration, and only then a request
 * for the list — the content of the page arrived last. The server now reads it
 * straight from Postgres and ships it inside the HTML.
 *
 * The poll survives because a building app genuinely changes on its own, but it
 * only arms itself when something is actually building. Before, it ran on every
 * load and was needed on roughly one in a hundred.
 */
export function AppsGrid({ initial, initialError }: { initial: App[]; initialError?: string }) {
  const [apps, setApps] = useState<App[]>(initial);
  const [err, setErr] = useState(initialError ?? "");

  const building = apps.some((a) => a.status === "building");

  useEffect(() => {
    if (!building) return;
    let stop = false;
    const tick = async () => {
      try {
        const d = await (await fetch("/api/apps")).json();
        if (stop) return;
        if (d.error) setErr(d.error);
        setApps(d.apps ?? []);
      } catch (e) {
        if (!stop) setErr(String(e));
      }
    };
    const id = setInterval(tick, 3000);
    return () => { stop = true; clearInterval(id); };
  }, [building]);

  const live = apps.filter((a) => a.ready).length;

  return (
    <>
      <section className="home-hero reveal" style={{ animationDelay: ".03s" }}>
        <div className="eyebrow">/ APPS</div>
        <h1>Your apps</h1>
        <div className="note">
          {`${apps.length} apps · ${live} live`}
          {err ? ` · ⚠ ${err.slice(0, 70)}` : ""}
        </div>
      </section>

      <section className="reveal" style={{ animationDelay: ".07s" }}>
        <div className="apps-grid">
          <Link href="/new" className="app-card new">
            <span className="plusbig">+</span>New app
          </Link>
          {apps.map((a) => a.status === "building" ? (
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
              {/*
                This used to be <iframe src={`https://${slug}.supersonic.cv`} /> — a
                live load of the app itself, to draw a 132px-tall thumbnail. Opening
                the dashboard opened every app on it: measured at 3.4s for one app's
                HTML alone, before its own scripts and fonts loaded inside the frame.
                Private apps spent that round trip to render a 401.

                It was also the loosest possible sandbox: allow-scripts together with
                allow-same-origin lets the framed app reach back into the origin that
                framed it.

                A screenshot captured at deploy time replaces it. Until that pipeline
                exists the monogram shows, and no cross-origin request is made at all.
              */}
              <div className="thumb">
                {a.thumbnail
                  ? <img src={a.thumbnail} alt="" loading="lazy" decoding="async" />
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
    </>
  );
}
