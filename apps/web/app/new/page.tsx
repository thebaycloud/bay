"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Zap, ArrowRight, ArrowLeft, Copy, Github, Link2, Terminal, RotateCcw, KeyRound } from "lucide-react";
import { Bracket } from "@/components/Bracket";
import { ThemeToggle } from "@/components/ThemeToggle";

const AGENT_PROMPT = `You are helping me publish my app to Supersonic — one-click hosting (https://supersonic.cv). I already have a Supersonic account. Run these steps from my project's root folder and keep me posted.

1. Make sure the CLI is installed:  supersonic help
   If "supersonic" isn't found, install it:  npm i -g supersonic-cli

2. Confirm I'm signed in:  supersonic whoami
   - Logged in → go to step 3.
   - Not logged in → sign me in:  supersonic login  (opens a browser; the CLI captures the token automatically). Only if I don't actually have an account yet, use "supersonic signup" instead.

3. Publish this folder — no git or GitHub required:  supersonic deploy
   This zips the project (skipping node_modules, .git, .env* and .gitignore'd files), uploads it, and builds it in the cloud. It streams progress and prints "✓ live: <url>" on success. If it exits WITHOUT that line, the deploy did not succeed — run "supersonic logs <app>" and "supersonic diagnose <app>" to find out why, fix it, and redeploy.

4. When it's live, send me the URL. If my app needs any environment variables/secrets, tell me which and set them with:  supersonic env <app> set KEY=VALUE  — then redeploy.

Useful commands: supersonic apps · status <app> · logs <app> · errors <app> · rollback <app>.
Important: never invent or hardcode secrets, and don't commit anything. Ask me for values you don't have.`;

type Door = "url" | "github" | "local";
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
  const [isStatic, setIsStatic] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const cloneToken = useRef<string | null>(null);

  useEffect(() => {
    const r = new URLSearchParams(window.location.search).get("repo");
    if (r) { setRepo(r.replace(/^https?:\/\//, "")); setDoor("url"); }
  }, []);

  function reset() {
    setPhase("idle"); setLogs([]); setDetected(null); setSecretsNeeded([]); setSecretVals({});
    setDetectMeta(null); setSlug(""); setLiveUrl(""); setElapsed(0); setError("");
  }

  const repoArg = () => (door === "github" ? `github.com/${repo}` : repo);

  async function begin() {
    if (!repo.trim()) return;
    setPhase("detecting"); setError("");
    try {
      const res = await fetch("/api/detect", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoArg() }),
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
    const t0 = performance.now();
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => setElapsed(Math.floor((performance.now() - t0) / 1000)), 250);
    try {
      const res = await fetch("/api/deploy", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoArg(), secrets, cloneToken: cloneToken.current }),
      });
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
          if (ev.type === "start") setSlug(ev.slug);
          else if (ev.type === "log") setLogs((l) => [...l, ev.line]);
          else if (ev.type === "detected") setDetected(ev.stack);
          else if (ev.type === "done") { setLiveUrl(ev.url); setSlug(ev.slug); setPhase("done"); }
          else if (ev.type === "error") { setError(ev.message); setPhase("error"); }
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
          <span className="logo"><Zap size={13} strokeWidth={2.4} /></span>
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
                ) : (
                  <>
                    <div className="repo">
                      <span className="pre">{door === "github" ? "github.com/" : "https://"}</span>
                      <input
                        value={repo}
                        onChange={(e) => setRepo(e.target.value)}
                        placeholder={door === "github" ? "owner/repo" : "github.com/owner/repo"}
                        onKeyDown={(e) => { if (e.key === "Enter") begin(); }}
                        autoFocus
                      />
                    </div>
                    <div className="deploy-cta">
                      <Bracket>
                        <button className="btn primary big" onClick={begin}>Deploy<ArrowRight size={13} /></button>
                      </Bracket>
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
                  <Bracket>
                    <button className="btn primary big" onClick={() => runDeploy(secretVals)}>Deploy<ArrowRight size={13} /></button>
                  </Bracket>
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
                  <Bracket>
                    <Link href={`/apps/${slug}`} className="btn primary">Open cockpit<ArrowRight size={13} /></Link>
                  </Bracket>
                </div>
              </div>
            )}

            {phase === "error" && (
              <div className="success" style={{ borderColor: "var(--ink-2)" }}>
                <span className="fix-badge">DEPLOY FAILED</span>
                <div className="u muted" style={{ marginTop: 12, maxWidth: "56ch", marginInline: "auto" }}>{error}</div>
                <div className="acts">
                  <button className="btn" onClick={reset}><RotateCcw size={13} />Start over</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <ThemeToggle />
    </div>
  );
}
