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
/**
 * An app's screenshot, with its initial as the fallback.
 *
 * Whether a screenshot exists is only known by asking for it — an app deployed
 * before the screenshot service, or one whose page failed to render, has none.
 * Rather than have the server check the bucket once per card before it can send
 * any HTML, the image asks for itself and the monogram takes over on 404.
 */
function Thumb({ slug, src }: { slug: string; src?: string }) {
  const [failed, setFailed] = useState(false);
  const url = src ?? `/api/apps/${encodeURIComponent(slug)}/thumbnail`;
  return (
    <div className="thumb">
      {failed
        ? <span className="thumb-mono">{slug.charAt(0).toUpperCase()}</span>
        : <img src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />}
    </div>
  );
}

/**
 * What the app said when asked, under the name it is filed by.
 *
 * Asked from the browser, one request per card, after the page is on screen.
 * Rendering it on the server would hold the entire dashboard behind the slowest
 * app on it — and the slowest app is the one most worth showing.
 */
function useProbes(apps: App[]) {
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});

  const slugs = apps.filter((a) => a.status !== "building").map((a) => a.slug).join(",");
  useEffect(() => {
    if (!slugs) return;
    let stop = false;
    for (const slug of slugs.split(",")) {
      fetch(`/api/apps/${encodeURIComponent(slug)}/probe`)
        .then((r) => r.json())
        .then((d) => { if (!stop) setProbes((p) => ({ ...p, [slug]: d.probe ?? null })); })
        // A probe that fails to run is left undefined, which renders as nothing.
        // Drawing "down" here would blame the app for our own request failing.
        .catch(() => {});
    }
    return () => { stop = true; };
  }, [slugs]);

  return probes;
}

type ProbeState = { verdict: "ok" | "warn" | "down"; label: string; preview: string } | null | undefined;

/**
 * The status line, which used to be a guess.
 *
 * `ready` is Cloud Run's opinion of the revision — its container answered a
 * startup probe on $PORT once. An app can pass that and refuse every real
 * request afterwards, and one does: `epvmx` serves Django's DisallowedHost and
 * drew exactly the same green LIVE as a working app. Until the probe answers,
 * `ready` is still all we have, so it is shown as the weaker claim it is.
 */
function Status({ ready, probe }: { ready: boolean; probe: ProbeState }) {
  if (probe === undefined) return <span className={`st ${ready ? "live" : "error"}`}><span className="d" />{ready ? "Live" : "Down"}</span>;
  if (probe === null) return <span className="st unknown"><span className="d" />Unchecked</span>;
  const word = probe.verdict === "ok" ? "Live" : probe.verdict === "warn" ? "Refusing" : "Down";
  return (
    <span className={`st ${probe.verdict}`} title={probe.label}>
      <span className="d" />{word}<span className="probe-label">{probe.label}</span>
    </span>
  );
}

export function AppsGrid({ initial, initialError }: { initial: App[]; initialError?: string }) {
  const [apps, setApps] = useState<App[]>(initial);
  const [err, setErr] = useState(initialError ?? "");
  const probes = useProbes(apps);

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
        <div className="hero-row">
          <h1>Your apps</h1>
          {/*
            Moved out of the grid. As a card it occupied an app-sized slot in the
            most valuable corner of the screen and never changed — which is most
            of the screen when a normal user has two or three apps, and this is
            the one thing on the page that is not one of theirs.
          */}
          <Link href="/new" className="btn-new">New app</Link>
        </div>
        <div className="note">
          {`${apps.length} apps · ${live} live`}
          {err ? ` · ⚠ ${err.slice(0, 70)}` : ""}
        </div>
      </section>

      <section className="reveal" style={{ animationDelay: ".07s" }}>
        <div className="apps-grid">
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

                A screenshot taken at deploy time replaces it — same origin, one
                image, no app code executed in the dashboard.
              */}
              <Thumb slug={a.slug} src={a.thumbnail} />
              <div className="card-body">
                <div className="r1">
                  <span className="nm">{a.name || a.slug}</span>
                  <Status ready={a.ready} probe={probes[a.slug]} />
                </div>
                {/*
                  What it answered, when that says more than a picture of it
                  does. A screenshot works for a site and not for an API: a
                  thumbnail of {"ok":true} is a picture of the word ok. HTML
                  bodies are deliberately blank here — they have the screenshot.
                */}
                <div className="url">{probes[a.slug]?.preview || `${a.slug}.supersonic.cv`}</div>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
