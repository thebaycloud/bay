"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Rocket, TriangleAlert, SlidersHorizontal, Check } from "lucide-react";

export interface App {
  slug: string; name: string; url: string; ready: boolean;
  region: string; image: string; status?: string; stage?: string;
  /** A screenshot captured at deploy time; absent until that pipeline exists. */
  thumbnail?: string;
  /** ISO instant the last deploy finished, and how long it ran. */
  deployedAt?: string;
  deployMs?: number;
  /** Why the last deploy failed. Present only when status is "failed". */
  error?: string;
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
function Thumb({ slug, src, version }: { slug: string; src?: string; version?: string }) {
  const [failed, setFailed] = useState(false);
  // The deploy stamp in the URL is what lets the answer be cached for a day
  // rather than five minutes: a new deploy produces a new URL, so a long cache
  // can never show yesterday's screenshot.
  const v = version ? `?v=${encodeURIComponent(version)}` : "";
  const url = src ?? `/api/apps/${encodeURIComponent(slug)}/thumbnail${v}`;
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
function useProbes(apps: App[], visible: Set<string>) {
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});
  // Asked-for slugs are never asked again: a card scrolling in and out of view
  // must not re-wake its app, and the answer it already has does not expire on
  // screen.
  const [asked] = useState(() => new Set<string>());

  const slugs = apps
    .filter((a) => a.status !== "building" && a.status !== "failed" && visible.has(a.slug) && !asked.has(a.slug))
    .map((a) => a.slug)
    .join(",");
  useEffect(() => {
    if (!slugs) return;
    for (const s of slugs.split(",")) asked.add(s);
    let stop = false;
    // One request for the whole page, streamed. Twenty-six separate requests
    // landed in the same tick against a browser that runs about six at a time
    // per origin, so most sat in a queue behind the slowest cold start; one
    // batched JSON reply fixed that and introduced a worse problem, holding
    // every card blank until the last app answered. NDJSON is both: one
    // connection, and a card lights up the moment its own app replies.
    (async () => {
      try {
        const res = await fetch("/api/probes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slugs: slugs.split(",") }),
        });
        const reader = res.body?.getReader();
        if (!reader) return;
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done || stop) break;
          buf += dec.decode(value, { stream: true });
          // A chunk can split a line; whatever follows the last newline is the
          // start of the next one and waits for the rest of itself.
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const { slug, probe } = JSON.parse(line);
            setProbes((p) => ({ ...p, [slug]: probe ?? null }));
          }
        }
        if (stop) void reader.cancel().catch(() => {});
      } catch {
        // A stream that fails leaves cards undefined, which renders as the
        // `ready` claim. Drawing "down" here would blame the apps for our own
        // request failing.
      }
    })();
    return () => { stop = true; };
  }, [slugs, asked]);

  return probes;
}

/**
 * Which cards are actually on screen.
 *
 * Twenty-six apps, four of them visible: probing all of them on load wakes
 * twenty-two scale-to-zero services nobody is looking at, and every one of those
 * is a cold start the reader waits behind. The observer keeps a slug once seen,
 * because a card that has been read does not need un-reading.
 */
function useVisible(slugs: string[]): [Set<string>, (slug: string) => (el: HTMLElement | null) => void] {
  const [seen, setSeen] = useState<Set<string>>(new Set());
  const observer = useRef<IntersectionObserver | null>(null);
  const nodes = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    // No IntersectionObserver (old browser, a test environment): fall back to
    // asking about everything, which is what this replaced.
    if (typeof IntersectionObserver === "undefined") { setSeen(new Set(slugs)); return; }
    observer.current = new IntersectionObserver(
      (entries) => {
        const arrived = entries.filter((e) => e.isIntersecting).map((e) => (e.target as HTMLElement).dataset.slug!);
        if (arrived.length) setSeen((s) => new Set([...s, ...arrived]));
      },
      // A screen ahead: the answer should be there by the time the card is.
      { rootMargin: "400px 0px" },
    );
    for (const el of nodes.current.values()) observer.current.observe(el);
    return () => observer.current?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ref = (slug: string) => (el: HTMLElement | null) => {
    if (!el) { nodes.current.delete(slug); return; }
    el.dataset.slug = slug;
    nodes.current.set(slug, el);
    observer.current?.observe(el);
  };

  return [seen, ref];
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

/**
 * What a row counts as, for the filter — from data the page already has.
 *
 * This used to read the probe's verdict, which arrives seconds after the page
 * does. That made the counts move under the reader and the chips untrustworthy
 * until the network settled: a filter must never depend on a value that has not
 * arrived. The probe still decides the WORD on the card, where a late correction
 * is information rather than a moving target.
 */
type Bucket = "live" | "down" | "building" | "failed";
function bucketOf(a: App): Bucket {
  if (a.status === "building") return "building";
  if (a.status === "failed") return "failed";
  return a.ready ? "live" : "down";
}

const FILTERS: { key: "all" | Bucket; label: string }[] = [
  { key: "all", label: "All" },
  { key: "live", label: "Live" },
  { key: "down", label: "Down" },
  { key: "building", label: "Building" },
  { key: "failed", label: "Failed" },
];

type SortKey = "deployed" | "name" | "oldest";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "deployed", label: "Recent" },
  { key: "name", label: "Name" },
  { key: "oldest", label: "Oldest" },
];

/**
 * The chosen order, applied here.
 *
 * The server still decides the DEFAULT — it is a database question and the first
 * paint has to be right — but re-ordering twenty-six rows already in memory is
 * not worth a round trip, and it used to cost one per click. When this list is
 * paged, the sort goes back to SQL, because then the browser no longer holds
 * everything there is to sort.
 *
 * A building app has no deploy date yet; it sorts as "now", which puts it where
 * the reader is looking.
 */
function sortApps(apps: App[], key: SortKey): App[] {
  const when = (a: App) => (a.status === "building" ? Date.now() : Date.parse(a.deployedAt ?? "") || 0);
  const nameOf = (a: App) => (a.name || a.slug).toLowerCase();
  const out = [...apps];
  if (key === "name") out.sort((x, y) => nameOf(x).localeCompare(nameOf(y)));
  else if (key === "oldest") out.sort((x, y) => when(x) - when(y));
  else out.sort((x, y) => when(y) - when(x));
  return out;
}

export function AppsGrid({ initial, initialError }: { initial: App[]; initialError?: string }) {
  const [apps, setApps] = useState<App[]>(initial);
  const [err, setErr] = useState(initialError ?? "");
  const [filter, setFilter] = useState<"all" | Bucket>("all");
  // View state, applied in memory. The server sets the default order; changing
  // it is not a page address and no longer a round trip either.
  const [sort, setSort] = useState<SortKey>("deployed");
  const [visible, visibleRef] = useVisible(apps.map((a) => a.slug));
  const probes = useProbes(apps, visible);

  // Both of these are pure functions of what is already loaded, so a click is a
  // re-render and nothing else — no request, no waiting, and counts that cannot
  // disagree with the rows they describe.
  const counts = { all: apps.length, live: 0, down: 0, building: 0, failed: 0 };
  for (const a of apps) counts[bucketOf(a)]++;
  const shown = sortApps(filter === "all" ? apps : apps.filter((a) => bucketOf(a) === filter), sort);

  const building = apps.some((a) => a.status === "building");

  /**
   * "goapi is live" — said at the moment it becomes true.
   *
   * The poll below already knows: it is watching for exactly this transition in
   * order to stop polling. Until now that knowledge went nowhere, so a deploy
   * finishing while the reader looked at another part of the page was silent,
   * and the only way to find out was to notice a card had changed colour.
   *
   * Compared against the PREVIOUS list rather than a flag, so a deploy started
   * anywhere — the CLI, another tab — announces itself here too.
   */
  const wasBuilding = useRef<Set<string>>(new Set());
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const now = new Set(apps.filter((a) => a.status === "building").map((a) => a.slug));
    const finished = [...wasBuilding.current].filter((slug) => !now.has(slug));
    wasBuilding.current = now;
    if (finished.length === 0) return;

    // One line even when three land together: a stack of toasts is a second
    // thing to read, and the cards behind them already carry the detail.
    const done = finished.map((slug) => apps.find((a) => a.slug === slug)).filter(Boolean) as App[];
    const failed = done.filter((a) => a.status === "failed");
    const ok = done.filter((a) => a.status !== "failed");
    const name = (a: App) => a.name || a.slug;
    const text = failed.length
      ? failed.length === 1 ? `${name(failed[0])} failed to deploy` : `${failed.length} deploys failed`
      : ok.length === 1
        ? `${name(ok[0])} is live${ok[0].deployMs ? ` — ${duration(ok[0].deployMs)}` : ""}`
        : `${ok.length} apps are live`;

    setToast({ text, ok: failed.length === 0 });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, [apps]);

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

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


  return (
    <>
      {/*
        The heading, and nothing else. "New app" moved to the bar; the "/ APPS"
        eyebrow named the page the rail already has highlighted; and the counts
        are printed on the filter chips below, where they are also a control
        rather than a sentence.

        The error keeps its line, because that one is not decoration — it is the
        only place a failed read of the app list is ever reported.
      */}
      <section className="home-hero reveal" style={{ animationDelay: ".03s" }}>
        <div className="hero-row">
          <h1>Your apps</h1>
        </div>
        {err ? <div className="note">⚠ {err.slice(0, 70)}</div> : null}
      </section>

      {/*
        A shelf, not a grid, and the brief inverted to get here. The first pass
        optimised for density because 14 apps were on the screen it was designed
        against — but those were the operator's own test apps. A normal user has
        two or three, so the problem was never fitting more in. It was that each
        one had a card's worth of room to say almost nothing.
      */}
      {/*
        The controls, on the card column's own edges. With two apps they are
        noise; with twenty-six the page was a directory you scrolled, and the
        one that had fallen over was wherever it happened to land.
      */}
      {apps.length > 1 && (
        <div className="shelf-tools reveal" style={{ animationDelay: ".05s" }}>
          <div className="seg">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                className={"act" + (filter === f.key ? " on" : "")}
                onClick={() => setFilter(f.key)}
                // A chip for a state nothing is in would be a button that
                // empties the page. "All" always stays.
                disabled={f.key !== "all" && counts[f.key] === 0}
              >
                {f.label}<span className="n">{counts[f.key]}</span>
              </button>
            ))}
          </div>
          <div className="tool-sort">
            <span className="tool-lbl">Sort</span>
            <div className="seg">
              {SORTS.map((s) => (
                <button
                  key={s.key}
                  className={"act" + (sort === s.key ? " on" : "")}
                  onClick={() => setSort(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Matches the cockpit's toast — same class, same corner, same timing. */}
      <div className={"toast" + (toast ? " show" : "") + (toast && !toast.ok ? " bad" : "")}>
        {toast?.ok === false ? <TriangleAlert size={13} /> : <Check size={13} />}
        <span>{toast?.text ?? ""}</span>
      </div>

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
          {shown.length === 0 && (
            // Reachable only by racing a probe: a chip disables itself at zero,
            // but a filtered app can go live while its filter is on screen.
            <div className="shelf-none">Nothing here right now.</div>
          )}
          {shown.map((a) => a.status === "failed" ? (
            /*
              The card the dashboard never used to draw. A failed deploy removed
              the app from this page altogether — the product went quiet exactly
              when it had the most to explain. No screenshot (there is nothing
              running to photograph), no probe, no Open button: what this app
              needs is the reason and a way back to the deploy.
            */
            <article key={a.slug} className="shelf-row failed">
              <div className="shelf-preview fail-mark"><div className="thumb"><TriangleAlert size={30} /></div></div>
              <div className="shelf-main">
                <div className="shelf-head">
                  <span className="nm">{a.name || a.slug}</span>
                  <span className="st fail"><span className="d" />Deploy failed</span>
                  <div className="head-acts">
                    <Link className="row-btn primary" href={`/apps/${a.slug}?tab=deployments`}>
                      <Rocket size={13} />Fix and redeploy
                    </Link>
                    <Link className="row-btn" href={`/apps/${a.slug}?tab=settings`}>
                      <SlidersHorizontal size={13} />Settings
                    </Link>
                  </div>
                </div>
                <div className="shelf-host">{a.slug}.supersonic.cv</div>
                {/* The reason, as the deploy recorded it. Clipped, because some
                    of these are a build log's last gasp and the card is not a
                    log viewer — the deployments tab is. */}
                {a.error ? <pre className="shelf-body fail-why">{a.error.slice(0, 240)}</pre> : null}
                <Deployed at={a.deployedAt} ms={a.deployMs} />
              </div>
            </article>
          ) : a.status === "building" ? (
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
            <article key={a.slug} className="shelf-row" ref={visibleRef(a.slug)}>
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
                <Thumb slug={a.slug} src={a.thumbnail} version={a.deployedAt} />
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
