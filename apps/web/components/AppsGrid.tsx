"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight, Rocket, TriangleAlert, SlidersHorizontal } from "lucide-react";

export interface App {
  slug: string; name: string; url: string; ready: boolean;
  region: string; image: string; status?: string; stage?: string;
  /** A screenshot captured at deploy time; absent until that pipeline exists. */
  thumbnail?: string;
  /** ISO instant the last deploy finished, and how long it ran. */
  deployedAt?: string;
  deployMs?: number;
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
  // A null probe means we could not ASK — the app has no Cloud Run service to
  // describe, which is true of every static app, since one shared server fronts
  // them all. "Unchecked" was the word for that, and it said nothing anyone can
  // act on while replacing the status of an app that is perfectly fine. When the
  // probe cannot run, `ready` is all we have — exactly as it was before probing
  // existed — so the weaker claim is shown rather than no claim at all.
  if (probe === null) return <span className={`st ${ready ? "live" : "error"}`}><span className="d" />{ready ? "Live" : "Down"}</span>;
  const word = probe.verdict === "ok" ? "Live" : probe.verdict === "warn" ? "Refusing" : "Down";
  return (
    <span className={`st ${probe.verdict}`} title={probe.label}>
      <span className="d" />{word}<span className="probe-label">{probe.label}</span>
    </span>
  );
}

/** "47s", "3m 12s" — a deploy's wall clock, at the precision anyone reads it at. */
function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

/**
 * When the app last shipped, and what that cost.
 *
 * Formatted after mount, never on the server: the date belongs in the reader's
 * timezone, and the server's is UTC, so rendering it in the HTML would hand React
 * two different strings for the same element on every card. The duration has no
 * timezone and is safe either way — it is the part of this line that survives
 * server rendering.
 */
function Deployed({ at, ms }: { at?: string; ms?: number }) {
  const [when, setWhen] = useState("");

  useEffect(() => {
    if (!at) return;
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return;
    setWhen(d.toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
    }));
  }, [at]);

  // An app deployed before the deploy store existed has no date to show. The
  // line still occupies its row so the cards keep one shape.
  if (!at) return <div className="shelf-when">&nbsp;</div>;
  return (
    <div className="shelf-when">
      <span className="sw-k">Last updated</span>
      {/* Empty for one paint, until the effect above knows the local zone. */}
      <span className="sw-v">{when || "—"}</span>
      {ms ? <><span className="sw-sep">·</span><span className="sw-k">Deployed in</span><span className="sw-v">{duration(ms)}</span></> : null}
    </div>
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
        {/*
          The heading stands alone. "New app" was here AND in the bar above it,
          two buttons for one action within 200px of each other; the bar keeps
          the copy, since it is on every page and this one only on this page.
        */}
        <div className="hero-row">
          <h1>Your apps</h1>
        </div>
        <div className="note">
          {`${apps.length} apps · ${live} live`}
          {err ? ` · ⚠ ${err.slice(0, 70)}` : ""}
        </div>
      </section>

      {/*
        A shelf, not a grid, and the brief inverted to get here. The first pass
        optimised for density because 14 apps were on the screen it was designed
        against — but those were the operator's own test apps. A normal user has
        two or three, so the problem was never fitting more in. It was that each
        one had a card's worth of room to say almost nothing.
      */}
      <section className="reveal" style={{ animationDelay: ".07s" }}>
        {apps.length === 0 ? (
          // The empty state used to be implicit: the "New app" card was the only
          // thing in the grid, so a new account saw it by accident. Moving that
          // button to the header took the accident away, and a first-time user
          // would have been shown a blank page.
          <div className="shelf-empty">
            <p>Nothing deployed yet.</p>
            <Link href="/new" className="btn-new">Deploy your first app</Link>
          </div>
        ) : (
        <div className="shelf">
          {apps.map((a) => a.status === "building" ? (
            <article key={a.slug} className="shelf-row building">
              <Link href={`/apps/${a.slug}?tab=deployments`} className="shelf-preview" aria-label={`${a.name || a.slug} — deployments`}>
                <div className="thumb"><span className="thumb-build">◐</span></div>
              </Link>
              <div className="shelf-main">
                <div className="shelf-head">
                  <span className="nm">{a.name || a.slug}</span>
                  {/* No "Building" badge. The stage line under the name already
                      says "deploying…", the thumbnail is a spinner, and the word
                      in the corner was a third telling of the same fact. */}
                  <div className="head-acts">
                    <Link className="row-btn primary" href={`/apps/${a.slug}?tab=deployments`}>
                      <Rocket size={13} />Watch deploy
                    </Link>
                  </div>
                </div>
                <div className="shelf-host">{a.stage}</div>
              </div>
            </article>
          ) : (
            <article key={a.slug} className="shelf-row">
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
              {/*
                A screenshot of a running app is a picture of a door, so the
                hover puts the handles on it: the two places this row can go,
                named, once the pointer is over the preview.
              */}
              <div className="shelf-preview">
                <Thumb slug={a.slug} src={a.thumbnail} />
                <div className="preview-open">
                  <Link className="po-btn primary" href={`/apps/${a.slug}`}>
                    <SlidersHorizontal size={13} />Manage app
                  </Link>
                  <a
                    className="po-btn"
                    href={`https://${a.slug}.supersonic.cv`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open website<ArrowUpRight size={14} />
                  </a>
                </div>
              </div>
              <div className="shelf-main">
                <div className="shelf-head">
                  {/*
                    Plain text. As a link it was a third route to the app's own
                    page and drew a hover the two real buttons beside it did
                    not — a title that behaves like a control while looking like
                    a heading. "Manage app" is the labelled way there now.
                  */}
                  <span className="nm">{a.name || a.slug}</span>
                  {/* Beside the name rather than in the far corner: it reads as
                      the app's subtitle, and the corner is worth more as a
                      place to act than as a place to label. */}
                  <Status ready={a.ready} probe={probes[a.slug]} />
                  {/* Manage leads and carries the fill: this is the dashboard,
                      and the address below is already a way to the site. */}
                  <div className="head-acts">
                    <Link className="row-btn primary" href={`/apps/${a.slug}`}>
                      <SlidersHorizontal size={13} />Manage app
                    </Link>
                    <a className="row-btn" href={`https://${a.slug}.supersonic.cv`} target="_blank" rel="noreferrer">
                      Open website<ArrowUpRight size={14} />
                    </a>
                  </div>
                </div>
                {/*
                  The address is the app, so it behaves like one: it goes where
                  it says it goes. It read as a link already — mono, under the
                  name, a hostname — and did nothing when clicked.
                */}
                <a className="shelf-host" href={`https://${a.slug}.supersonic.cv`} target="_blank" rel="noreferrer">
                  {a.slug}.supersonic.cv
                </a>
                {/*
                  What it answered, when that says more than a picture of it
                  does. A screenshot works for a site and not for an API: a
                  thumbnail of {"ok":true} is a picture of the word ok. HTML
                  bodies are deliberately blank here — they have the screenshot,
                  and the row keeps its height either way.
                */}
                {probes[a.slug]?.preview
                  ? <pre className="shelf-body">{probes[a.slug]!.preview}</pre>
                  : null}
                {/* Sits with the controls at the foot of the row: it is the
                    row's last line of status, and the two read as one block. */}
                <Deployed at={a.deployedAt} ms={a.deployMs} />
                {/*
                  Actions, which a card had no room for at all — the whole card
                  was one link to one place, so every other destination cost a
                  page load to reach. Real anchors rather than a nested <Link>
                  inside a linked card, which is invalid markup and unreachable
                  by keyboard.

                  Drawn as one segmented control rather than three floating
                  outlines. Separately they read as labels: a hairline the same
                  colour as every rule on the page and nothing joining them.
                  Sharing a frame and an icon apiece makes them a control.
                */}
                <div className="shelf-actions">
                  <div className="seg">
                    <Link className="act" href={`/apps/${a.slug}?tab=deployments`}><Rocket size={13} />Deployments</Link>
                    <Link className="act" href={`/apps/${a.slug}?tab=issues`}><TriangleAlert size={13} />Issues</Link>
                    <Link className="act" href={`/apps/${a.slug}?tab=settings`}><SlidersHorizontal size={13} />Settings</Link>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
        )}
      </section>
    </>
  );
}
