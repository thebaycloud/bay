"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowLeft, Copy, Github, Link2, Terminal, RotateCcw, KeyRound } from "lucide-react";
import { Mark } from "@/components/Mark";
import { Paywall, type PaywallReason } from "@/components/Paywall";
import { DeployFilm } from "@/components/DeployFilm";
import { drive as advanceFilm, START as FILM_START, type FilmDrive } from "@/lib/deploy-film";

// The 402 bodies carry a `reason`; anything unrecognised (an older server, a
// proxy that ate the body) falls back to the generic plan comparison rather
// than to a specific limit the user may not have hit.
const REASONS: PaywallReason[] = ["app_limit", "public_limit", "build_limit", "fix_used", "no_account"];
function asReason(v: unknown): PaywallReason {
  return REASONS.includes(v as PaywallReason) ? (v as PaywallReason) : "choose_plan";
}

const AGENT_PROMPT = `You are publishing my app to Supersonic — a cloud for small software (agent manual: https://supersonic.cv/llms.txt). Run everything from my project's root folder, and keep me posted in plain language — I don't read logs.

1. Install the CLI if it isn't already:  npm i -g supersonic-cli

2. Publish it, and WAIT for the answer:
   supersonic deploy --wait
   The first run opens a browser for me to sign in. Without --wait the command returns the moment the URL is reserved and finishes building after you have stopped watching, so you would report success for a build that has not happened yet.

3. The deploy succeeded only when you see a line starting "✓ live:". Anything else is not done. Getting it green is your job, not mine:  supersonic logs <app>  shows what production actually saw and  supersonic diagnose <app>  hands you a fix. Fix the code, redeploy, repeat. Don't paste me an error and ask what to do.

4. The URL will ask me to sign in — every app is private until I say otherwise. That is not a bug; tell me the app is live and private, and that I can make it public in the dashboard.

My .env travels with the deploy automatically — you do not need to copy keys across. Use  supersonic env <app> set KEY=VALUE  only for a value that is NOT in my .env. Skip DATABASE_URL and anything pointing at localhost: Supersonic provisions the database and injects that itself.

If my app has migrations and nothing in the repo says how to run them — no Procfile release line, nothing in compose.yml, fly.toml or package.json — say so and add one. An app deployed against an empty schema serves its homepage and fails everything else.

If a key is missing or is obviously a placeholder (sk_test_…, "changeme"), ask me for the real one in one sentence: what it is and where I get it. Never invent, hardcode, commit, or print a secret value.`;

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

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const r = q.get("repo");
    if (r) { setRepo(r.replace(/^https?:\/\//, "")); setDoor("url"); }
    // Coming back from GitHub. `connected` re-asks rather than trusting the
    // name in the URL: the list is the truth and it was just changed.
    if (q.get("connected")) { setDoor("github"); setGhConnections(null); }
    const err = q.get("github_error");
    if (err) {
      setDoor("github");
      setGhTrouble(
        err === "no-installation" ? "That didn't finish connecting. Try again — it takes about a minute."
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
    setGhRepos(null); setGhTrouble("");
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

  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="topbrand">
          <span className="logo"><Mark size={14} onDark /></span>
          SUPERSONIC
        </Link>
        <div className="spacer" />
        <Link href="/" className="btn"><ArrowLeft size={13} />Apps</Link>
      </header>

      <div className="content">
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
                          <a className="btn primary big" href={ghLinks?.installUrl ?? "#"}>
                            <Github size={13} />Connect GitHub<ArrowRight size={13} />
                          </a>
                          <span className="hint">takes about a minute</span>
                        </div>
                      </>
                    ) : (
                      <>
                        {ghConnections.length > 1 && (
                          <div className="doors" style={{ marginBottom: 10 }}>
                            {ghConnections.map((c) => (
                              <button
                                key={c.installationId}
                                className={"door" + (ghInstallation === c.installationId ? " on" : "")}
                                onClick={() => setGhInstallation(c.installationId)}
                              >{c.accountLogin}</button>
                            ))}
                          </div>
                        )}
                        {ghTrouble && <p className="lead" style={{ margin: "0 0 10px", fontSize: 13 }}>{ghTrouble}</p>}
                        {ghRepos === null ? (
                          <p className="lead" style={{ margin: "0 0 14px", fontSize: 13 }}>Reading what you picked…</p>
                        ) : ghRepos.length === 0 && !ghTrouble ? (
                          <p className="lead" style={{ margin: "0 0 14px", fontSize: 13 }}>
                            This account is connected, but no repositories were shared with us yet.
                          </p>
                        ) : (
                          <div className="gh-repos">
                            {ghRepos.map((r) => (
                              <button
                                key={r.fullName}
                                className="gh-repo"
                                onClick={() => { setRepo(r.fullName); begin(r.fullName); }}
                              >
                                <span className="name">{r.fullName}</span>
                                {r.private && <span className="tag">private</span>}
                              </button>
                            ))}
                          </div>
                        )}
                        <p className="lead" style={{ margin: "10px 0 0", fontSize: 12, opacity: 0.7 }}>
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

            {(phase === "deploying" || phase === "done" || phase === "error") && (
              <div className="stage">
                <div className="stage-head">
                  <span className="t">
                    <span className="mono">{phase === "error" ? "✕" : "▸"}</span>
                    {phase === "done" ? `Deployed ${slug}` : phase === "error" ? "Deploy failed" : `Deploying ${slug || "…"}`}
                  </span>
                  <span className="clock">{elapsed}s</span>
                </div>

                <DeployFilm drive={film} elapsed={elapsed} />

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

            {phase === "done" && (
              <div className="success">
                <div className="success-live"><span className="d" />Live</div>
                <div className="big">{liveUrl.replace(/^https?:\/\//, "")}</div>
                <div className="u muted">deployed in {elapsed}s · Cloud Run · us-central1</div>
                <div className="acts">
                  <a className="btn" href={liveUrl} target="_blank" rel="noreferrer">Visit<ArrowRight size={13} /></a>
                  
                    <Link href={`/apps/${slug}`} className="btn primary">Open cockpit<ArrowRight size={13} /></Link>
                  
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
      </div>

      {/* Always dismissable: there is no state a person can be in where the
          only thing behind this modal is a locked account. Free is always
          behind it, with their apps still running. */}
      {paywall && <Paywall reason={paywall} onClose={() => setPaywall(null)} />}
    </div>
  );
}
