"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowLeft, Copy, Github, Link2, Terminal, RotateCcw, KeyRound, Search } from "lucide-react";
import { Mark } from "@/components/Mark";
import { agentPrompt } from "@/lib/prompts";
import { Paywall, type PaywallReason } from "@/components/Paywall";
import { DeployFilm } from "@/components/DeployFilm";
import { productName } from "@/lib/brand";
import { drive as advanceFilm, START as FILM_START, type FilmDrive } from "@/lib/deploy-film";

// The 402 bodies carry a `reason`; anything unrecognised (an older server, a
// proxy that ate the body) falls back to the generic plan comparison rather
// than to a specific limit the user may not have hit.
const REASONS: PaywallReason[] = ["app_limit", "public_limit", "build_limit", "fix_used", "no_account"];
function asReason(v: unknown): PaywallReason {
  return REASONS.includes(v as PaywallReason) ? (v as PaywallReason) : "choose_plan";
}

const AGENT_PROMPT = agentPrompt();

type Door = "url" | "github" | "local";
/** One GitHub account this workspace has connected. */
interface GhConnection { installationId: number; accountLogin: string }
/** One repository that connection can see. */
interface GhRepo { fullName: string; private: boolean; defaultBranch: string; pushedAt: string | null }
type Phase = "idle" | "detecting" | "secrets" | "deploying" | "done" | "error";

interface Detected {
  framework: string;
  language: string;
  database: { engine: string | null; via: string | null };
  cache: string | null;
  secretsNeeded: string[];
}

export default function NewApp() {
  const [door, setDoor] = useState<Door>("local");
  const [repo, setRepo] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [logs, setLogs] = useState<string[]>([]);
  const [detected, setDetected] = useState<Detected | null>(null);
  const [secretsNeeded, setSecretsNeeded] = useState<string[]>([]);
  const [secretVals, setSecretVals] = useState<Record<string, string>>({});
  const [detectMeta, setDetectMeta] = useState<{ framework: string; dbEngine: string | null } | null>(null);
  const [slug, setSlug] = useState("");
  const [liveUrl, setLiveUrl] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [fixPrompt, setFixPrompt] = useState("");
  const [canUpgrade, setCanUpgrade] = useState(false);
  const [fixCopied, setFixCopied] = useState(false);
  const [paywall, setPaywall] = useState<PaywallReason | null>(null);
  const [isStatic, setIsStatic] = useState(false);
  // What the film is being shown. Folded from the same events the terminal
  // below prints, so the picture can never be ahead of, or behind, the log.
  const [film, setFilm] = useState<FilmDrive>(FILM_START);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // The dry dock's log column, pinned to its own bottom as lines arrive.
  const logRef = useRef<HTMLDivElement>(null);
  const cloneToken = useRef<string | null>(null);

  // The GitHub door. `null` means "not asked yet" and is distinct from an empty
  // list, which means "asked, and nothing is connected" — the two draw
  // different screens and collapsing them would flash the connect button at
  // somebody who is already connected.
  const [ghConnections, setGhConnections] = useState<GhConnection[] | null>(null);
  const [ghInstallation, setGhInstallation] = useState<number | null>(null);
  const [ghRepos, setGhRepos] = useState<GhRepo[] | null>(null);
  const [ghLinks, setGhLinks] = useState<{ installUrl: string; configureUrl: string } | null>(null);
  const [ghTrouble, setGhTrouble] = useState("");
  /** Narrows the repository list. Cleared whenever the account changes, so the
      previous account's term never hides this one's rows off screen. */
  const [ghQuery, setGhQuery] = useState("");

  const beginRef = useRef<((repo?: string) => void) | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const r = q.get("repo");
    wantedName.current = (q.get("name") ?? "").trim();
    if (r) { setRepo(r.replace(/^https?:\/\//, "")); setDoor("url"); }
    // Handed off from the Ship-new dialog, which already asked WHERE the code
    // comes from. This page's remaining job is the film, so it starts straight
    // away rather than showing the doors again with one already answered.
    const inst = q.get("installation_id");
    if (q.get("src") === "github" && r) {
      setDoor("github");
      if (inst) setGhInstallation(Number(inst));
      // A frame later, so the state above is committed before begin() reads it.
      setTimeout(() => beginRef.current?.(r), 0);
      return;
    }
    // Coming back from GitHub. `connected` re-asks rather than trusting the
    // name in the URL: the list is the truth and it was just changed.
    if (q.get("connected")) { setDoor("github"); setGhConnections(null); }
    const err = q.get("github_error");
    if (err) {
      setDoor("github");
      setGhTrouble(
        err === "no-installation" ? "That didn't finish connecting. Try again — it takes about a minute."
        : err === "taken" ? "That GitHub account is already connected to another workspace here. Uninstall our App from it on GitHub, then connect it again."
        : err === "bad-credentials" ? "We can't reach GitHub right now. This one is on us — nothing you do will fix it."
        : err === "no-workspace" ? "Your account isn't set up yet. Ship something once and this will work."
        : "We couldn't finish connecting to GitHub. Try again in a moment.",
      );
    }
  }, []);

  // Asked when the door is opened, not on mount: most people arrive to use a
  // different door and this is a round trip they never needed.
  useEffect(() => {
    if (door !== "github" || ghConnections !== null) return;
    let alive = true;
    fetch("/api/github/repos")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setGhConnections(d.connections ?? []);
        setGhLinks({ installUrl: d.installUrl, configureUrl: d.configureUrl });
        // One connected account is the common case and choosing between one
        // thing is not a choice.
        if (d.connections?.length === 1) setGhInstallation(d.connections[0].installationId);
      })
      .catch(() => { if (alive) setGhConnections([]); });
    return () => { alive = false; };
  }, [door, ghConnections]);

  useEffect(() => {
    if (ghInstallation === null) return;
    let alive = true;
    setGhRepos(null); setGhTrouble(""); setGhQuery("");
    fetch(`/api/github/repos?installation_id=${ghInstallation}`)
      .then(async (r) => ({ ok: r.ok, d: await r.json() }))
      .then(({ ok, d }) => {
        if (!alive) return;
        if (ok) { setGhRepos(d.repos ?? []); return; }
        // Three refusals, three different next actions — and never GitHub's own
        // words, which are text we did not write.
        setGhRepos([]);
        setGhTrouble(
          d.reason === "no-installation" ? "That account isn't connected any more. Connect it again to pick a repository."
          : d.reason === "bad-credentials" ? "We can't reach GitHub right now. This one is on us — nothing you do will fix it."
          : "GitHub isn't answering. Try again in a moment.",
        );
      })
      .catch(() => { if (alive) setGhTrouble("GitHub isn't answering. Try again in a moment."); });
    return () => { alive = false; };
  }, [ghInstallation]);

  /**
   * The install link, carrying whatever the app was already going to be called.
   *
   * GitHub gives `state` back to the setup redirect untouched, which is the
   * only way a value survives a trip through github.com — see
   * `nameFromCallback`. Empty when nothing named it, and then the link is
   * exactly what it was.
   */
  function connectUrl(): string {
    const base = ghLinks?.installUrl;
    if (!base) return "#";
    const name = wantedName.current.trim();
    return name ? `${base}?state=${encodeURIComponent(name)}` : base;
  }

  /** The rows the search leaves, matched on the whole `owner/repo`. */
  function shownRepos(): GhRepo[] {
    const q = ghQuery.trim().toLowerCase();
    if (!ghRepos) return [];
    return q ? ghRepos.filter((r) => r.fullName.toLowerCase().includes(q)) : ghRepos;
  }

  function reset() {
    setPhase("idle"); setLogs([]); setDetected(null); setSecretsNeeded([]); setSecretVals({});
    setDetectMeta(null); setSlug(""); setLiveUrl(""); setElapsed(0); setError("");
    // Cleared with everything else, or the previous failure's fix is still on
    // screen underneath the next attempt's logs.
    setFixPrompt(""); setCanUpgrade(false); setFixCopied(false);
    setFilm(FILM_START);
  }

  // Only the Git URL door types a repository now; the GitHub door passes the
  // one that was clicked straight into begin().
  const repoArg = () => repo;

  /**
   * What detect actually inspected, and through which connection.
   *
   * A ref rather than the `repo` state, because the secrets step deploys
   * minutes after detect ran and must send the same two values detect was
   * given. Reading state there would deploy whatever the field says now.
   */
  const asked = useRef<{ repo: string; installationId: number | null }>({ repo: "", installationId: null });

  /**
   * What the Ship-new dialog called this app, if it called it anything.
   *
   * A ref rather than state for the same reason `asked` is one: the deploy can
   * run minutes after the query string was read, and this has to be the value
   * that arrived, not whatever a re-render left behind. Empty means "the server
   * names it from the repository", which is what every deploy did before.
   */
  const wantedName = useRef("");

  // Kept in a ref so the query-param effect above can start a run without
  // being declared after the state it reads.
  beginRef.current = (r?: string) => { void begin(r); };

  async function begin(pickedRepo?: string) {
    // From the picker the name is passed in: setRepo has not landed yet when
    // this runs, and reading it here would send an empty repository.
    const target = pickedRepo ? `github.com/${pickedRepo}` : repoArg();
    const installationId = door === "github" ? ghInstallation : null;
    if (!target.trim() || target === "github.com/") return;
    asked.current = { repo: target, installationId };
    setPhase("detecting"); setError("");
    try {
      const res = await fetch("/api/detect", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: target, installationId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "detection failed");
      setDetectMeta({ framework: data.framework, dbEngine: data.dbEngine });
      // Lets the deploy reuse the clone detection just made instead of fetching
      // the same repository again. Purely an optimisation — if it is missing or
      // stale the deploy clones as before.
      cloneToken.current = typeof data.cloneToken === "string" ? data.cloneToken : null;
      setIsStatic(data.serve?.mode === "static");
      if (Array.isArray(data.secretsNeeded) && data.secretsNeeded.length) {
        setSecretsNeeded(data.secretsNeeded);
        setSecretVals(Object.fromEntries(data.secretsNeeded.map((s: string) => [s, ""])));
        setPhase("secrets");
      } else {
        runDeploy({});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  async function runDeploy(secrets: Record<string, string>) {
    setPhase("deploying"); setLogs([]); setDetected(null); setLiveUrl(""); setError(""); setElapsed(0);
    // A retry that keeps the last attempt's fix would show a fix for an error
    // the user is no longer looking at.
    setFixPrompt(""); setCanUpgrade(false);
    // A retry is a new deploy and therefore a new film: back to the dark, the
    // empty dock and the keel blocks.
    setFilm(FILM_START);
    const t0 = performance.now();
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => setElapsed(Math.floor((performance.now() - t0) / 1000)), 250);
    try {
      const res = await fetch("/api/deploy", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: asked.current.repo,
          installationId: asked.current.installationId,
          secrets,
          cloneToken: cloneToken.current,
          // Omitted when nobody named it, so the server keeps naming apps after
          // their repository exactly as it did.
          ...(wantedName.current ? { name: wantedName.current } : {}),
        }),
      });
      // A billing gate returns a JSON 402 *before* the SSE stream — surface the
      // paywall / upgrade modal instead of trying to parse it as events.
      if (res.status === 402) {
        const d = await res.json().catch(() => ({}));
        // The server names the limit it enforced. Guessing here — the old code
        // read `paywall` as "trial ended" and everything else as "too many
        // apps" — meant a build-quota refusal was explained as an app cap.
        setPaywall(asReason(d.reason));
        setError(d.error || ""); setPhase("error");
        return;
      }
      if (!res.body) throw new Error("no response stream");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const raw = part.replace(/^data: /, "").trim();
          if (!raw) continue;
          const ev = JSON.parse(raw);
          // Every event, including the ones this switch has no branch for:
          // `stage` is what cuts the film, and it is deliberately not narrated
          // in the terminal — a person reading logs does not need "stage: fleet
          // started" and the picture is already saying it.
          setFilm((f) => advanceFilm(f, ev));
          if (ev.type === "start") setSlug(ev.slug);
          else if (ev.type === "log") setLogs((l) => [...l, ev.line]);
          else if (ev.type === "detected") setDetected(ev.stack);
          else if (ev.type === "done") { setLiveUrl(ev.url); setSlug(ev.slug); setPhase("done"); }
          // A failed deploy carries more than a message. `fixPrompt` is a
          // paste-ready brief for the user's own coding agent, written by the
          // server on every failure and — until now — dropped on the floor
          // here: this branch read `ev.message` and ignored the other two
          // fields entirely. That made the dashboard's failure screen a dead
          // end while the CLI, hitting its own endpoint, showed the fix.
          //
          // It is the free plan's headline feature, so the person it failed was
          // whoever deployed from the web and had it not work — the first
          // experience a new account is likely to have.
          else if (ev.type === "error") {
            setError(ev.message);
            setFixPrompt(typeof ev.fixPrompt === "string" ? ev.fixPrompt : "");
            // `upgrade` is set when the repair agent was declined by a plan
            // limit rather than by the failure itself — a spent free fix, or a
            // month's auto-fix runs used up.
            setCanUpgrade(Boolean(ev.upgrade));
            setPhase("error");
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    } finally {
      if (timer.current) clearInterval(timer.current);
    }
  }

  const busy = phase === "deploying";
  /* The deploy has the page from the moment it starts. `/new` exists to do
     exactly this one thing, so the form does not sit behind the picture
     waiting to be dimmed — it is simply not what this page is about any more. */
  const docked = phase === "deploying" || phase === "done";

  /* The newest line is the one being waited on, so the log follows it down.
     Only when the reader is already at the bottom: somebody who has scrolled
     up to read what the detector said should not be yanked back every 250ms.
     A line and a half of slack: a fractional scroll height rarely lands on
     zero, and a reader one line off the bottom meant to be at it. */
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 40) return;
    el.scrollTop = el.scrollHeight;
  }, [logs, busy]);

  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="topbrand">
          <span className="logo"><Mark size={14} onDark /></span>
          {productName().toUpperCase()}
        </Link>
        <div className="spacer" />
        <Link href="/" className="btn"><ArrowLeft size={13} />Apps</Link>
      </header>

      <div className="content">
        {!docked && (
        <div className="wrap">
          <div className="ruler reveal" />
          <div className="newflow reveal" style={{ animationDelay: ".03s" }}>
            <div className="eyebrow">/ NEW</div>
            <h1>Deploy an app</h1>
            <p className="lead">
              Publish the app you built — straight from your computer through your coding agent, or from GitHub.
              We detect it, provision the backend, and put it live. If it needs a secret only you have, we ask for just that.
            </p>

            {phase === "idle" && (
              <>
                <div className="doors">
                  <button className={"door" + (door === "local" ? " on" : "")} onClick={() => setDoor("local")}>
                    <Terminal size={12} style={{ marginRight: 6, verticalAlign: -1 }} />Coding agent
                  </button>
                  <button className={"door" + (door === "github" ? " on" : "")} onClick={() => setDoor("github")}>
                    <Github size={12} style={{ marginRight: 6, verticalAlign: -1 }} />GitHub
                  </button>
                  <button className={"door" + (door === "url" ? " on" : "")} onClick={() => setDoor("url")}>
                    <Link2 size={12} style={{ marginRight: 6, verticalAlign: -1 }} />Git URL
                  </button>
                </div>

                {door === "local" ? (
                  <>
                    <p className="lead" style={{ margin: "0 0 14px", fontSize: 13 }}>
                      Paste this into <b>Claude Code</b>, <b>Cursor</b>, or <b>Codex</b> — your agent installs the CLI, signs you in, and publishes this folder. No git, no setup.
                    </p>
                    <div className="prompt-box agent"><div className="inner" style={{ whiteSpace: "pre-wrap" }}>{AGENT_PROMPT}</div></div>
                    <div className="deploy-cta">
                      <button className="btn primary" onClick={() => navigator.clipboard?.writeText(AGENT_PROMPT)}>
                        <Copy size={13} />Copy prompt for your agent
                      </button>
                      <span className="hint">paste into Claude Code / Cursor / Codex</span>
                    </div>
                  </>
                ) : door === "github" ? (
                  <>
                    {ghConnections === null ? (
                      <p className="lead" style={{ margin: "0 0 14px", fontSize: 13 }}>Looking for your GitHub accounts…</p>
                    ) : ghConnections.length === 0 ? (
                      <>
                        <p className="lead" style={{ margin: "0 0 14px", fontSize: 13 }}>
                          Connect GitHub once and your private code shows up here. We only ever read it — and only the repositories you pick.
                        </p>
                        {ghTrouble && <p className="lead" style={{ margin: "0 0 10px", fontSize: 13 }}>{ghTrouble}</p>}
                        <div className="deploy-cta">
                          <a className="btn primary big" href={connectUrl()}>
                            <Github size={13} />Connect GitHub<ArrowRight size={13} />
                          </a>
                          <span className="hint">takes about a minute</span>
                        </div>
                      </>
                    ) : (
                      <>
                        {/* The accounts, and the way to add one.
                            
                            Shown at ONE account as well as at several, which it
                            was not: a person who connected the wrong account —
                            an organisation with one repository instead of the
                            personal account with sixty — saw that account's
                            short list, a link to widen its selection, and no way
                            at all to connect the right one. The install link
                            existed only on the screen for somebody with no
                            connections, which is the one person who does not
                            need it twice. */}
                        <div className="doors" style={{ marginBottom: 10 }}>
                          {ghConnections.map((c) => (
                            <button
                              key={c.installationId}
                              className={"door" + (ghInstallation === c.installationId ? " on" : "")}
                              onClick={() => setGhInstallation(c.installationId)}
                            >{c.accountLogin}</button>
                          ))}
                          <a className="door" href={connectUrl()}>
                            <Github size={12} />&nbsp;Add an account
                          </a>
                        </div>
                        {ghTrouble && <p className="lead" style={{ margin: "0 0 10px", fontSize: 13 }}>{ghTrouble}</p>}
                        {ghRepos === null ? (
                          <p className="lead" style={{ margin: "0 0 14px", fontSize: 13 }}>Reading what you picked…</p>
                        ) : ghRepos.length === 0 && !ghTrouble ? (
                          <p className="lead" style={{ margin: "0 0 14px", fontSize: 13 }}>
                            This account is connected, but no repositories were shared with us yet.
                          </p>
                        ) : (
                          <>
                            {/* The search shows up once the list is long enough
                                to scroll. Below that it is a second thing to
                                read above rows already on screen. */}
                            {ghRepos.length > 5 && (
                              <div className="gh-search">
                                <Search size={13} />
                                <input
                                  aria-label="Search repositories"
                                  value={ghQuery}
                                  onChange={(e) => setGhQuery(e.target.value)}
                                  placeholder="Search repositories…"
                                />
                              </div>
                            )}
                            <div className="gh-repos">
                              {shownRepos().length === 0 ? (
                                <div className="gh-repo" style={{ opacity: 0.7 }}>
                                  <span className="name">Nothing here matches “{ghQuery.trim()}”.</span>
                                </div>
                              ) : shownRepos().map((r) => (
                                <button
                                  key={r.fullName}
                                  className="gh-repo"
                                  onClick={() => { setRepo(r.fullName); begin(r.fullName); }}
                                >
                                  <span className="name">{r.fullName}</span>
                                  {/* The branch that will ship from now on, said
                                      here rather than asked for: picking one is a
                                      second click on the screen whose whole job is
                                      the first, and it is changeable afterwards in
                                      the app's own panel. */}
                                  <span className="tag branch">{r.defaultBranch}</span>
                                  {r.private && <span className="tag">private</span>}
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                        <p className="lead" style={{ margin: "10px 0 0", fontSize: 12, opacity: 0.7 }}>
                          Every push to that branch ships your app. You can change the branch, or turn it off, any time.
                        </p>
                        <p className="lead" style={{ margin: "4px 0 0", fontSize: 12, opacity: 0.7 }}>
                          Not seeing one? <a href={ghLinks?.configureUrl ?? "#"}>Choose which repositories we can see</a>.
                        </p>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <div className="repo">
                      <span className="pre">https://</span>
                      <input
                        value={repo}
                        onChange={(e) => setRepo(e.target.value)}
                        placeholder="github.com/owner/repo"
                        onKeyDown={(e) => { if (e.key === "Enter") begin(); }}
                        autoFocus
                      />
                    </div>
                    <div className="deploy-cta">
                      <button className="btn primary big" onClick={() => begin()}>Deploy<ArrowRight size={13} /></button>
                      <span className="hint">live in ~1–2 minutes</span>
                    </div>
                  </>
                )}
              </>
            )}

            {phase === "detecting" && (
              <div className="stage">
                <div className="stage-head"><span className="t"><span className="mono">▸</span>Inspecting repo…</span></div>
                <div className="term"><div className="ln show"><span className="arrow">·</span><span className="tx muted">cloning &amp; detecting stack…</span></div></div>
              </div>
            )}

            {phase === "secrets" && (
              <div className="secrets-panel">
                <div className="secrets-head">
                  <KeyRound size={14} />
                  <div>
                    <div className="sh-t">This app needs {secretsNeeded.length} secret{secretsNeeded.length > 1 ? "s" : ""}</div>
                    <div className="sh-s">
                      {detectMeta?.framework}
                      {detectMeta?.dbEngine ? ` · we'll provision ${detectMeta.dbEngine} automatically` : ""} · only you have these values
                    </div>
                  </div>
                </div>
                {isStatic && (
                  // A static app has no server, so these are build-time variables
                  // baked into the bundle — anyone who opens the site can read
                  // them. That is how every VITE_* variable has always worked, but
                  // a field labelled "secret" implies the opposite, so say it.
                  <div className="secrets-warn">
                    ⚠ This app is served as static files, so these values are built
                    into the bundle and <strong>anyone visiting the site can read them</strong>.
                    Only put in keys that are safe in public — never a database password
                    or a server-side API key.
                  </div>
                )}
                {secretsNeeded.map((s) => (
                  <div className="secret-row" key={s}>
                    <label>{s}</label>
                    <input
                      type="password"
                      placeholder="paste value"
                      value={secretVals[s] ?? ""}
                      onChange={(e) => setSecretVals((v) => ({ ...v, [s]: e.target.value }))}
                    />
                  </div>
                ))}
                <div className="deploy-cta" style={{ marginTop: 4 }}>
                  
                    <button className="btn primary big" onClick={() => runDeploy(secretVals)}>Deploy<ArrowRight size={13} /></button>
                  
                  <button className="btn" onClick={() => runDeploy({})}>Skip &amp; deploy anyway</button>
                </div>
              </div>
            )}

            {/* A deploy that is RUNNING is watched in the dry dock — see
                `drydock` at the bottom of this file. What is left here is the
                wreckage of one that failed: the words, without the picture. The
                film's break and its repair drone are worth watching while the
                agent is actually working, which is in the window; by the time
                this screen is up the story is over and the fix below is what
                has to be read. */}
            {phase === "error" && (
              <div className="stage">
                <div className="stage-head">
                  <span className="t">
                    <span className="mono">✕</span>
                    Deploy failed
                  </span>
                  <span className="clock">{elapsed}s</span>
                </div>

                {detected && (
                  <div className="detected">
                    <span className="chip">{detected.framework}</span>
                    <span className="chip">{detected.language}</span>
                    {detected.database.engine && <span className="chip">{detected.database.engine}</span>}
                    {detected.cache && <span className="chip">{detected.cache}</span>}
                    {detected.secretsNeeded.map((s) => <span key={s} className="chip secret">{s}</span>)}
                  </div>
                )}

                <div className="term">
                  {logs.map((l, i) => {
                    const ok = /^(Detected|Provision|Live at|Injecting|Agent fixed)/.test(l);
                    const agent = /^agent · /.test(l);
                    return (
                      <div className="ln show" key={i}>
                        <span className={ok ? "g" : "arrow"}>{ok ? "✓" : agent ? "◆" : "·"}</span>
                        <span className="tx">{l}</span>
                      </div>
                    );
                  })}
                  {busy && <div className="ln show"><span className="arrow">▸</span><span className="tx muted">working…</span></div>}
                </div>
              </div>
            )}

            {phase === "error" && (
              <div className="success" style={{ borderColor: "var(--ink-2)" }}>
                <span className="fix-badge">DEPLOY FAILED</span>
                <div className="u muted" style={{ marginTop: 12, maxWidth: "56ch", marginInline: "auto" }}>{error}</div>
                {/* The fix, when the server wrote one. Shown in full rather than
                    behind a disclosure: it is meant to be read once and pasted,
                    and a person who has just watched a deploy fail should not
                    have to find it. */}
                {fixPrompt && (
                  <div className="fixbox">
                    <div className="fixbox-h">Hand this to your coding agent</div>
                    <pre className="fixbox-body">{fixPrompt}</pre>
                  </div>
                )}
                <div className="acts">
                  {fixPrompt && (
                    <button
                      className="btn primary"
                      onClick={() => {
                        navigator.clipboard?.writeText(fixPrompt);
                        setFixCopied(true);
                        setTimeout(() => setFixCopied(false), 2000);
                      }}
                    >
                      <Copy size={13} />{fixCopied ? "Copied" : "Copy the fix"}
                    </button>
                  )}
                  {/* Only where a PLAN decided this, not where the build simply
                      broke. Offering an upgrade for a failure money cannot fix
                      is the kind of prompt that reads as a shakedown. */}
                  {canUpgrade && (
                    <button className="btn" onClick={() => setPaywall("fix_used")}>
                      Have us fix it instead
                    </button>
                  )}
                  <button className="btn" onClick={reset}><RotateCcw size={13} />Start over</button>
                </div>
              </div>
            )}
          </div>
        </div>
        )}

        {/* THE DRY DOCK — a deploy that is running, in a window built for it.

            A container deploy is 90 seconds during which this page has exactly
            one thing on it worth looking at. That used to be the entire screen,
            edge to edge, with the last six log lines written over the water in a
            corner — and a full-bleed render with no chrome around it reads as a
            screensaver. Nothing on it said this was YOUR app being built, and the
            log was there to be glanced at rather than read.

            It is a window now, and the window does the explaining the picture
            cannot: a title in the film's own language, the build's log down the
            left where a log belongs, the picture taking the rest. She is built in
            the yard, and when she goes out under the bridge the app is live.

            It is the PAGE, not a modal over one. `/new` is already the screen
            for this — putting a window over its own form meant dimming a form
            nobody could use and locking the scroll of a page nobody could see.
            So the form gives way and the dock takes the content area, with the
            top bar left where it is: a deploy runs on the server, and somebody
            who wants to go and look at their other apps should be able to.

            It stays up when the deploy lands, because the ending is the point:
            the sun comes up, she sails under the bridge, and the address is the
            film's own endcard. The footer is what to do about it. */}
        {docked && (
          <div className={"dockpage" + (phase === "done" ? " done" : "")}>
            {/* No `role="dialog"`: this is the page's own content and its
                heading says so. A dialog role here would tell a screen reader
                to expect something dismissable, which it is not. */}
            <section className="drydock">
              <header className="drydock-head">
                <div className="t">
                  <b>{phase === "done" ? "Shipped." : "Your app is being shipped"}</b>
                  {/* Only at the end. While she is being built the title says
                      it, the picture shows it, and a line explaining the
                      picture underneath is one voice too many. */}
                  {phase === "done" && (
                    <span>She left the yard in {elapsed}s and is under the bridge. Your app is live.</span>
                  )}
                </div>
                <div className="meta">
                  <span className={"dot" + (phase === "done" ? " live" : "")} />
                  <span className="nm">{slug || "…"}</span>
                  <span className="clock">{elapsed}s</span>
                </div>
              </header>

              <div className="drydock-body">
                {/* The build's own words — all of them, in order, wrapped rather
                    than cut, and pinned to the bottom as they arrive. */}
                <aside className="drydock-log">
                  <div className="lh">Build log</div>
                  <div className="lb" ref={logRef}>
                    {logs.map((l, i) => {
                      const ok = /^(Detected|Provision|Live at|Injecting|Agent fixed)/.test(l);
                      const agent = /^agent · /.test(l);
                      return (
                        <div key={`${i}-${l}`}>
                          <span className={"k" + (ok ? " g" : agent ? " a" : "")}>{ok ? "✓" : agent ? "◆" : "·"}</span>
                          <span className="m">{l}</span>
                        </div>
                      );
                    })}
                    {busy && (
                      <div className="working">
                        <span className="k">▸</span>
                        <span className="m">working…</span>
                      </div>
                    )}
                  </div>
                </aside>

                <div className="drydock-film">
                  <DeployFilm drive={film} elapsed={elapsed} full />
                </div>
              </div>

              <footer className="drydock-foot">
                {phase === "done" ? (
                  <a className="addr" href={liveUrl} target="_blank" rel="noreferrer">
                    {liveUrl.replace(/^https?:\/\//, "")}
                  </a>
                ) : (
                  /* The only thing a person watching a 90-second wait wants told,
                     and both halves of it are true: how long this takes, and that
                     the picture is following the deploy rather than a clock. */
                  <span className="hint">
                    Most ships leave the yard in about 90 seconds.
                    {/* Dropped on a narrow window, where the row has one line in
                        it and the first half is the half that answers "how long". */}
                    <span className="more"> The film waits on your deploy, not on a timer.</span>
                  </span>
                )}
                {phase === "done" && (
                  <div className="acts">
                    <a className="btn" href={liveUrl} target="_blank" rel="noreferrer">Visit<ArrowRight size={13} /></a>
                    <Link href={`/apps/${slug}`} className="btn primary">Open cockpit<ArrowRight size={13} /></Link>
                    {/* The way out of a picture that has finished playing. */}
                    <button className="btn" onClick={reset}><RotateCcw size={13} />Deploy another</button>
                  </div>
                )}
              </footer>
            </section>
          </div>
        )}

      </div>

      {/* Always dismissable: there is no state a person can be in where the
          only thing behind this modal is a locked account. Free is always
          behind it, with their apps still running. */}
      {paywall && <Paywall reason={paywall} onClose={() => setPaywall(null)} />}
    </div>
  );
}
