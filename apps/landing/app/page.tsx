"use client";

import { useState } from "react";
import {
  Zap, Rocket, Database, Terminal, Bot, Activity, Link2,
  Check, X, ArrowRight, Github, Crown, Palette, MessageSquare, Gauge, Wrench, ChevronDown,
} from "lucide-react";
import { GridPattern } from "@/components/magicui/grid-pattern";
import { Globe } from "@/components/magicui/globe";
import { Terminal as Term, TypingAnimation, AnimatedSpan } from "@/components/magicui/terminal";
import { AiChat } from "@/components/sections/ai-chat";

const roles = [
  { icon: Crown, name: "Owner", desc: "Deploys the app, controls who's in, and manages everything from one place." },
  { icon: Palette, name: "Designer", desc: "Tweaks the look and ships changes — no backend, no setup, just design and redeploy." },
  { icon: MessageSquare, name: "Commenter", desc: "Opens the live app and pins feedback right on it, like leaving comments in a Google Doc." },
];

const APP = "https://app.supersonic.cv";

// Monochrome marks for the coding agents. (For pixel-exact official logos, drop
// SVGs into public/logos/ and swap the `mark` — these are clean stand-ins.)
function ClaudeMark() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden>
      {Array.from({ length: 12 }).map((_, i) => {
        const a = (i * 30 * Math.PI) / 180;
        return (
          <line key={i}
            x1={12 + Math.cos(a) * 3.2} y1={12 + Math.sin(a) * 3.2}
            x2={12 + Math.cos(a) * 10.4} y2={12 + Math.sin(a) * 10.4}
            stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        );
      })}
    </svg>
  );
}
const CursorMark = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M5 3l14 8-6 1.5-1.6 6.5z" /></svg>
);
const CodexMark = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    {[0, 60, 120].map((a) => (
      <ellipse key={a} cx="12" cy="12" rx="3.1" ry="8.4" transform={`rotate(${a} 12 12)`} />
    ))}
  </svg>
);
const OpencodeMark = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="4.5" width="18" height="15" rx="1" /><path d="M7 10l2.6 2.5L7 15M12.5 15H16" /></svg>
);
const ClineMark = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M8 8l-4 4 4 4M16 8l4 4-4 4" /></svg>
);

const agents = [
  { name: "Claude Code", mark: <ClaudeMark /> },
  { name: "Cursor", mark: <CursorMark /> },
  { name: "OpenAI Codex", mark: <CodexMark /> },
  { name: "opencode", mark: <OpencodeMark /> },
  { name: "Cline", mark: <ClineMark /> },
];

const features = [
  { icon: Rocket, name: "One-click publish", tag: "~40s", desc: "Point us at the app you built and we put it online — with its own web address — in about 40 seconds. No setup, nothing technical." },
  { icon: Link2, name: "Custom domains", desc: "Start on a free yourapp.supersonic.cv address, or connect a domain you already own like yourapp.com. The secure padlock is set up for you, automatically." },
  { icon: Database, name: "Database included", desc: "Your app's data is saved and backed up from the very first click — nothing to set up, no accounts to create, no settings to copy. It's just there." },
  { icon: Activity, name: "Always watched", tag: "24/7", desc: "We keep an eye on your live app around the clock and tell you the moment something goes wrong — in plain words, not error codes." },
  { icon: Terminal, name: "Runs itself through your AI", desc: "Your coding agent — Claude Code, Cursor, Codex — can publish, check on, and fix your app entirely on its own using our command-line tool. You don't have to lift a finger." },
  { icon: Bot, name: "An agent on the inside", desc: "Supersonic runs its own AI inside your cloud. When something breaks it works out the fix — and on Pro, applies it and gets your app healthy again, by itself." },
];

const starter = [
  ["1 app", true], ["Database, storage & custom domain", true], ["Share with up to 3 people", true],
  ["Paste-ready fix prompts when something breaks", true], ["Auto-fix failed deploys", false], ["Remove the Supersonic badge", false],
];
const pro = [
  ["Unlimited apps", true], ["Database, storage & custom domain", true], ["Unlimited sharing + roles", true],
  ["Paste-ready fix prompts when something breaks", true], ["Auto-fix failed deploys", true], ["Remove the Supersonic badge", true],
];

const faqs = [
  ["Do I need to change my code?", "No. Deploy your app exactly as you built it — we detect the stack and handle everything on the cloud side. The only thing we ever ask you for is a secret that only you should hold."],
  ["Do I need a GitHub account?", "No. You can deploy straight from your computer — just run supersonic deploy in your project folder. GitHub is there as an option if you want it, not a requirement."],
  ["What kinds of apps can I deploy?", "Anything that runs in a container — Next.js, Vite, Python, Go, Rust, whatever. Common stacks work out of the box; for anything unusual, your coding agent describes how to run it and we take it from there."],
  ["What happens when my app breaks?", "We catch the error in production and write your coding agent a precise, paste-ready fix. On Pro, our agent applies it and redeploys to green automatically. Either way, we never edit your code without you."],
  ["Where does my app actually run?", "On Google Cloud, on your own isolated infrastructure — a real production deployment that scales from one visitor to millions, with a secure custom domain."],
];

const AGENT_PROMPT = `You are helping me publish my app to Supersonic — one-command hosting for vibecoders (agent manual: https://supersonic.cv/llms.txt). Run these from my project's root folder and keep me posted.

1. Install the CLI if it isn't already:  npm i -g supersonic-cli

2. Publish this folder:  supersonic deploy
   That's the whole thing. The first time, it opens a browser for me to sign in or create an account (a new account starts a free trial automatically — nothing to pay). Then it packages this folder (no git or GitHub needed), builds it in the cloud, and prints "✓ live: <url>". Send me that URL.

3. If it exits WITHOUT a "✓ live" URL, the deploy failed:  run  supersonic diagnose  and apply the paste-ready fix it gives you, then run  supersonic deploy  again.

If my app needs secrets/env vars, tell me which and set them with  supersonic env <app> set KEY=VALUE, then redeploy. Never invent or hardcode secrets, and don't commit anything — ask me for values you don't have.`;

// The prompt is agent-agnostic; the switcher only makes it clear which coding
// agent you'll paste it into (and labels the button accordingly).
const HERO_AGENTS = [
  { name: "Claude Code", mark: <ClaudeMark /> },
  { name: "Codex", mark: <CodexMark /> },
  { name: "Cursor", mark: <CursorMark /> },
];

function CopyPrompt({ accent, switcher }: { accent?: boolean; switcher?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [sel, setSel] = useState(0);
  const [open, setOpen] = useState(false);
  const current = HERO_AGENTS[sel];
  const label = switcher ? "Copy prompt for" : "Copy prompt for your AI";
  const copiedLabel = switcher ? "Copied — paste it in" : "Copied — paste into your AI";
  return (
    <div className="promptcta">
      <button
        className={accent ? "btn accent" : "btn ghost"}
        onClick={() => {
          navigator.clipboard?.writeText(AGENT_PROMPT).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? <><Check size={15} /> {copiedLabel}</> : <><Terminal size={15} /> {label}</>}
      </button>
      {switcher && (
        <div className="agent-dd">
          <button
            type="button"
            className="agent-trigger"
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <span className="as-mk">{current.mark}</span>
            <span className="agent-name">{current.name}</span>
            <ChevronDown size={13} className="agent-caret" />
          </button>
          {open && (
            <>
              <div className="agent-backdrop" onClick={() => setOpen(false)} />
              <ul className="agent-menu" role="listbox">
                {HERO_AGENTS.map((a, i) => (
                  <li
                    key={a.name}
                    role="option"
                    aria-selected={i === sel}
                    className={"agent-item" + (i === sel ? " on" : "")}
                    onClick={() => { setSel(i); setOpen(false); }}
                  >
                    <span className="as-mk">{a.mark}</span>{a.name}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MachineView() {
  return (
    <div className="machine">
      <h1>SUPERSONIC — machine-readable</h1>
      <div className="m-sub">Hosting for vibecoders. Built to be operated by coding agents.</div>

      <div className="m-h">What it is</div>
      <div>One command turns an app on a computer into a real, live product on the internet — database, custom domain and monitoring included.</div>

      <div className="m-h">Publish an app · do this for your user</div>
      <div className="step"><span className="n">1</span><div>Install the CLI — <span className="cmd">npm i -g supersonic-cli</span></div></div>
      <div className="step"><span className="n">2</span><div>Create the account — <span className="cmd">supersonic signup</span> — opens a browser for your user to finish sign-up, then hands control back to you.</div></div>
      <div className="step"><span className="n">3</span><div>Publish from the project folder, no git required — <span className="cmd">supersonic deploy</span></div></div>

      <div className="m-h">The contract</div>
      <div>A Dockerfile that listens on <span className="cmd">$PORT</span> ships any language. Common stacks (Next.js, Python, Go…) work without one.</div>

      <div className="m-h">CLI</div>
      <pre>supersonic deploy | status | logs | errors | diagnose | env | exec | rollback</pre>

      <div className="m-foot">
        <CopyPrompt />
        <a href="/llms.txt">Full manual → /llms.txt</a>
      </div>
    </div>
  );
}

export default function Page() {
  const [machine, setMachine] = useState(false);
  return (
    <>
      <nav className="nav">
        <a className="brand" href="/"><span className="mk"><Zap size={13} strokeWidth={2.5} /></span>SUPERSONIC</a>
        <div className="links">
          <a href="#features">Product</a>
          <a href="#pricing">Pricing</a>
        </div>
        <span className="spacer" />
        <a className="btn ghost sm" href={APP}>Open app</a>
        <a className="btn accent sm" href={`${APP}/signup`}>Sign up</a>
      </nav>

      {machine ? <MachineView /> : <main className="frame">
        {/* HERO */}
        <section className="sec hero">
          <div className="eyebrow">Deploy in 60 seconds</div>
          <h1>The fastest hosting<br />in the world.</h1>
          <div className="cta">
            <CopyPrompt accent switcher />
          </div>
          <div className="art">
            <GridPattern width={34} height={34} style={{ stroke: "var(--line-2)" }} className="[mask-image:radial-gradient(520px_circle_at_50%_38%,white,transparent)]" />
            <img src="/bridge.png" alt="A bridge to production" />
            <div className="art-term"><AiChat /></div>
          </div>
        </section>

        {/* CODING AGENTS */}
        <section className="strip">
          <div className="lbl"><span className="eyebrow">Built for the tools you already use</span></div>
          <div className="agents">
            {agents.map((a) => (
              <div className="agent-card" key={a.name}>
                <span className="am">{a.mark}</span>
                <span className="an">{a.name}</span>
              </div>
            ))}
          </div>
        </section>

        {/* SPEED */}
        <section className="sec speed-sec">
          <div className="sec-head">
            <span className="eyebrow">Speed</span>
            <h2>Live in 40 seconds.<br />Every time.</h2>
            <p>Static sites skip the container entirely. Real apps build on a warm, cached pipeline. Redeploys are near-instant — so your team iterates at the speed of thought.</p>
          </div>
          <div className="speed-stats">
            <div className="stat"><span className="sv">~40s</span><span className="sl">idea to live URL</span></div>
            <div className="stat"><span className="sv">0</span><span className="sl">config files to write</span></div>
            <div className="stat"><span className="sv">∞</span><span className="sl">redeploys, always fast</span></div>
          </div>
        </section>

        {/* FEATURES */}
        <section className="sec" id="features">
          <div className="sec-head">
            <span className="eyebrow">What you get</span>
            <h2>Everything a real app needs,<br />handled by AI</h2>
            <p>You bring the idea and the code. We bring the entire cloud — provisioned, connected, and looked after.</p>
          </div>
          <div className="cells">
            {features.map((f) => (
              <div className="cell" key={f.name}>
                {f.tag && <span className="tag">{f.tag}</span>}
                <span className="ic"><f.icon size={17} /></span>
                <h3>{f.name}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* COLLABORATION / ROLES */}
        <section className="sec roles-sec" id="collaborate">
          <div className="sec-head">
            <span className="eyebrow">Built for teams</span>
            <h2>Share a working app<br />like a Google Doc.</h2>
            <p>Supersonic isn&apos;t just hosting — it&apos;s where your team builds together. Everyone gets the right access, on the same live app.</p>
          </div>
          <div className="roles">
            {roles.map((r) => (
              <div className="role" key={r.name}>
                <span className="role-ic"><r.icon size={19} /></span>
                <h3>{r.name}</h3>
                <p>{r.desc}</p>
              </div>
            ))}
          </div>
          <div className="roles-foot">
            <span>Owner · Designer · Commenter — all on one link. Fast deploys mean the whole loop — build, see it live, comment, fix, ship again — happens in minutes, not days.</span>
          </div>
        </section>

        {/* AGENT */}
        <section className="sec agent-sec">
          <div className="agent-copy">
            <span className="eyebrow">The agent on the inside</span>
            <h2>Something breaks at 2am?<br />It&apos;s already fixed.</h2>
            <p>Supersonic runs its own AI inside your cloud. It watches your live app, and the moment something fails it <b>reads your code, writes the fix, and redeploys to green</b> — on its own. You wake up to a working app and a changelog.</p>
            <div className="agent-flow">
              <span className="af">Detects the error</span><ArrowRight size={14} />
              <span className="af">Reads the code</span><ArrowRight size={14} />
              <span className="af">Writes the fix</span><ArrowRight size={14} />
              <span className="af on">Redeploys ✓</span>
            </div>
          </div>
          <div className="agent-term">
            <Term className="hero-term">
              <AnimatedSpan delay={200} className="term-red">✕ TypeError: cannot read &apos;map&apos; of undefined — Notes.jsx:42</AnimatedSpan>
              <AnimatedSpan delay={900} className="term-cyan">◆ agent · reading the repo…</AnimatedSpan>
              <AnimatedSpan delay={1600} className="term-cyan">◆ agent · notes is undefined before fetch resolves</AnimatedSpan>
              <AnimatedSpan delay={2300} className="term-dim">◆ agent · patched Notes.jsx (useState([]))</AnimatedSpan>
              <AnimatedSpan delay={3000} className="term-dim">▸ redeploying…</AnimatedSpan>
              <AnimatedSpan delay={3700} className="term-green">✓ healthy again — 0 errors</AnimatedSpan>
            </Term>
          </div>
        </section>

        {/* GLOBE */}
        <section className="sec globe-sec">
          <div className="copy">
            <span className="eyebrow">Global by default</span>
            <h2>Deploy anywhere.<br />Live everywhere.</h2>
            <p>Every app ships to Google&apos;s global network with a secure custom domain and auto-scaling — fast for the person next door and the one across the planet.</p>
            <div className="cities">
              <span>San Francisco</span><span>New York</span><span>London</span><span>Berlin</span><span>Tokyo</span><span>Singapore</span><span>Sydney</span>
            </div>
          </div>
          <div className="stage">
            <Globe />
          </div>
        </section>

        {/* PRICING */}
        <section className="sec" id="pricing">
          <div className="sec-head">
            <span className="eyebrow">Pricing</span>
            <h2>Two plans.<br />No infrastructure bills.</h2>
            <p>Flat pricing. Your cloud is included — you never touch a Google Cloud invoice.</p>
          </div>
          <div className="compare">
            <div className="plan">
              <div className="pname">Basic</div>
              <div className="pdesc">Ship one app, share it with your team, and get paste-ready fixes for your coding agent.</div>
              <div className="price"><b>$12</b> / month</div>
              {starter.map(([label, on]) => (
                <div className={"row" + (on ? "" : " off")} key={String(label)}>
                  <span className="mk">{on ? <Check size={15} strokeWidth={2.2} /> : <X size={14} />}</span>{label}
                </div>
              ))}
              <div className="cta"><a className="btn ghost" href={`${APP}/new`}>Start with Basic</a></div>
            </div>
            <div className="plan">
              <div className="pname">Pro</div>
              <div className="pdesc">Unlimited apps and sharing, plus Autopilot — failed deploys fix themselves and redeploy to green.</div>
              <div className="price"><b>$20</b> / month</div>
              {pro.map(([label, on]) => (
                <div className={"row" + (on ? "" : " off")} key={String(label)}>
                  <span className="mk">{on ? <Check size={15} strokeWidth={2.2} /> : <X size={14} />}</span>{label}
                </div>
              ))}
              <div className="cta"><a className="btn accent" href={`${APP}/new`}>Go Pro <ArrowRight size={15} /></a></div>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="sec faq-sec">
          <div className="lead">
            <span className="eyebrow">Before you begin</span>
            <h2>Everything you need to know</h2>
          </div>
          <div className="faq-list">
            {faqs.map(([q, a]) => (
              <details className="faq-item" key={q}>
                <summary><span className="q">{q}</span><span className="pm">+</span></summary>
                <div className="a">{a}</div>
              </details>
            ))}
          </div>
        </section>

        {/* FINAL CTA */}
        <section className="sec final">
          <span className="eyebrow">Your next step</span>
          <h2 style={{ marginTop: 14 }}>Ship your first app today.</h2>
          <div className="cta"><a className="btn accent" href={`${APP}/new`}>Deploy your first app <ArrowRight size={15} /></a></div>
        </section>

        {/* FOOTER */}
        <footer>
          <div className="foot">
            <div>
              <div className="brand"><span className="mk"><Zap size={13} strokeWidth={2.5} /></span>SUPERSONIC</div>
              <p style={{ color: "var(--ink-2)", fontSize: 13, marginTop: 12, maxWidth: "30ch" }}>The cloud for vibecoders. Deploy anything in one click.</p>
            </div>
            <div className="col">
              <h4>Product</h4>
              <a href="#features">Features</a><a href="#pricing">Pricing</a><a href={APP}>Open app</a>
            </div>
            <div className="col">
              <h4>Company</h4>
              <a href="#">About</a><a href="#">Blog</a><a href="#">Careers</a>
            </div>
            <div className="col">
              <h4>Resources</h4>
              <a href={APP}>Docs</a><a href="#"><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Github size={13} /> GitHub</span></a><a href="#">Status</a>
            </div>
          </div>
          <div className="foot-bar">
            <span>© 2026 Supersonic — all rights reserved</span>
            <span className="spacer" />
            <span>supersonic.cv</span>
          </div>
        </footer>
      </main>}

      <button className="mode-toggle mode-fixed" onClick={() => setMachine((m) => !m)} title="Machine-readable view">
        <span className={"seg" + (!machine ? " on" : "")}>Human</span>
        <span className={"seg" + (machine ? " on" : "")}>Machine</span>
      </button>

      <a className="ss-badge" href={APP} target="_blank" rel="noreferrer">
        <Zap size={11} strokeWidth={2.6} />Runs on Supersonic
      </a>
    </>
  );
}
