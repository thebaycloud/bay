"use client";

// The landing page. The hero is one full-bleed picture with the headline left
// and the copy right; the nav rides on the picture and turns into the usual
// blurred bar once it scrolls off. Everything visual comes from the design
// system in globals.css — `landing.css` only adds layout.
//
// Styles are scoped under `.ss` so globals.css stays the shared vocabulary
// rather than something this page has quietly rewritten.

import { useEffect, useRef, useState } from "react";
import "./landing.css";
import {
  Rocket, Database, Terminal, Bot, Activity, Link2,
  Check, X, ArrowRight, Github, Crown, Palette, MessageSquare, ChevronDown, Copy,
} from "lucide-react";
import { Mark } from "@/components/Mark";
import { Globe } from "@/components/magicui/globe";
import { Terminal as Term, AnimatedSpan } from "@/components/magicui/terminal";

const APP = "https://app.supersonic.cv";

const roles = [
  { icon: Crown, name: "Owner", desc: "Deploys the app, controls who's in, and manages everything from one place." },
  { icon: Palette, name: "Designer", desc: "Tweaks the look and ships changes — no backend, no setup, just design and redeploy." },
  { icon: MessageSquare, name: "Commenter", desc: "Opens the live app and pins feedback right on it, like leaving comments in a Google Doc." },
];

const features = [
  { icon: Rocket, name: "One-click publish", tag: "~40s", desc: "Point us at the app you built and we put it online — with its own web address — in about 40 seconds. No setup, nothing technical." },
  { icon: Link2, name: "Custom domains", desc: "Start on a free yourapp.supersonic.cv address, or connect a domain you already own like yourapp.com. The secure padlock is set up for you, automatically." },
  { icon: Database, name: "Database included", desc: "Your app's data is saved and backed up from the very first click — nothing to set up, no accounts to create, no settings to copy. It's just there." },
  { icon: Activity, name: "Always watched", tag: "24/7", desc: "We keep an eye on your live app around the clock and tell you the moment something goes wrong — in plain words, not error codes." },
  { icon: Terminal, name: "Runs itself through your AI", desc: "Your coding agent — Claude Code, Cursor, Codex — can publish, check on, and fix your app entirely on its own using our command-line tool. You don't have to lift a finger." },
  { icon: Bot, name: "An agent on the inside", desc: "Supersonic runs its own AI inside your cloud. When something breaks it works out the fix — and on Pro, applies it and gets your app healthy again, by itself." },
];

// Three paid tiers, no free plan — every one of them opens with a trial.
const basic = [
  ["1 app", true], ["Database, storage & custom domain", true], ["Share with up to 3 people", true],
  ["Paste-ready fix prompts when something breaks", true], ["Auto-fix failed deploys", false], ["Remove the Supersonic badge", false],
  ["Website analytics", false], ["An agent that fixes your code in production", false],
];
const pro = [
  ["Unlimited apps", true], ["Database, storage & custom domain", true], ["Unlimited sharing + roles", true],
  ["Paste-ready fix prompts when something breaks", true], ["Auto-fix failed deploys", true], ["Remove the Supersonic badge", true],
  ["Website analytics", false], ["An agent that fixes your code in production", false],
];
const scale = [
  ["Unlimited apps", true], ["Database, storage & custom domain", true], ["Unlimited sharing + roles", true],
  ["Paste-ready fix prompts when something breaks", true], ["Auto-fix failed deploys", true], ["Remove the Supersonic badge", true],
  ["Website analytics", true], ["An agent that fixes your code in production", true],
];

const faqs = [
  ["Do I need to change my code?", "No. Deploy your app exactly as you built it — we detect the stack and handle everything on the cloud side. The only thing we ever ask you for is a secret that only you should hold."],
  ["Do I need a GitHub account?", "No. You can deploy straight from your computer — just run supersonic deploy in your project folder. GitHub is there as an option if you want it, not a requirement."],
  ["What kinds of apps can I deploy?", "Anything that runs in a container — Next.js, Vite, Python, Go, Rust, whatever. Common stacks work out of the box; for anything unusual, your coding agent describes how to run it and we take it from there."],
  ["What happens when my app breaks?", "We catch the error in production and write your coding agent a precise, paste-ready fix. On Pro, our agent applies it and redeploys to green automatically. Either way, we never edit your code without you."],
  ["Where does my app actually run?", "On Google Cloud, on your own isolated infrastructure — a real production deployment that scales from one visitor to millions, with a secure custom domain."],
];

const AGENT_PROMPT = `You are publishing my app to Supersonic — one-command hosting for vibecoders (agent manual: https://supersonic.cv/llms.txt). Run everything from my project's root folder, and keep me posted in plain language — I don't read logs.

1. Install the CLI if it isn't already:  npm i -g supersonic-cli

2. Work out how this app runs in dev mode (npm run dev, uvicorn main:app --port 8000, bin/rails s — you know the stack), then publish it with that command:
   supersonic deploy --dev-cmd "<how to run it>"
   The first run opens a browser for me to sign in or create an account — a new account starts a free trial automatically, nothing to pay. It prints a live URL within seconds and finishes the real build in the background. Send me that URL.

3. Getting it green is your job, not mine. If the deploy exits without a "✓ live:" line, or the live URL is broken, work it out yourself:  supersonic diagnose <app>  hands you a paste-ready fix, and  supersonic logs <app>  and  supersonic errors <app>  show what production actually saw. Fix the code, redeploy, repeat until it works. Don't paste me an error and ask what to do.

Don't ask me for anything you can find yourself. The keys my app uses — OPENAI_API_KEY, STRIPE_SECRET_KEY and the like — are already in my local .env / .env.local, and .env.example lists which ones it expects. Read them from there and set them yourself with  supersonic env <app> set KEY=VALUE, then redeploy — .env is never uploaded with my code, so anything the app reads has to be set this way.

Two exceptions: skip DATABASE_URL and anything pointing at localhost, because Supersonic provisions the database and injects that itself; and if a key is missing or is obviously a placeholder or test value (sk_test_…, "changeme"), ask me for the real one in one sentence — what it is and where I get it. Never invent, hardcode, commit, or print a secret value.`;

// One command, four package managers — the shadcn CLI docs block.
const PMS = [
  { id: "npm", cmd: "npx supersonic deploy" },
  { id: "pnpm", cmd: "pnpm dlx supersonic deploy" },
  { id: "yarn", cmd: "yarn dlx supersonic deploy" },
  { id: "bun", cmd: "bunx supersonic deploy" },
];

function CommandBlock() {
  const [pm, setPm] = useState(0);
  const [copied, setCopied] = useState(false);
  const cmd = PMS[pm].cmd;
  return (
    <div className="cmdblock">
      <div className="cmdblock-bar">
        <div className="cmdblock-tabs" role="tablist" aria-label="Package manager">
          {PMS.map((p, i) => (
            <button
              key={p.id}
              role="tab"
              aria-selected={i === pm}
              className={"cmdblock-tab" + (i === pm ? " on" : "")}
              onClick={() => setPm(i)}
            >
              {p.id}
            </button>
          ))}
        </div>
        <button
          className="cmdblock-copy"
          aria-label={copied ? "Copied" : "Copy command"}
          onClick={() => {
            navigator.clipboard?.writeText(cmd).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre className="cmdblock-body"><code>{cmd}</code></pre>
    </div>
  );
}

// The machine-readable view, carried over unchanged: the same page written for
// a coding agent rather than a person. The toggle is the only way in.
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

function ModeToggle({ machine, onToggle }: { machine: boolean; onToggle: () => void }) {
  return (
    <button className="mode-toggle mode-fixed" onClick={onToggle} title="Machine-readable view">
      <span className={"seg" + (!machine ? " on" : "")}>Human</span>
      <span className={"seg" + (machine ? " on" : "")}>Machine</span>
    </button>
  );
}

// The staircase across the pricing table: it runs along the bottom of what each
// plan covers, then steps down to where the next plan's coverage ends. Measured
// rather than hard-coded, because row heights depend on how the labels wrap.
function usePlanStep() {
  const ref = useRef<HTMLDivElement>(null);
  const [d, setD] = useState("");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const draw = () => {
      const box = el.getBoundingClientRect();
      const plans = Array.from(el.querySelectorAll<HTMLElement>(".plan"));
      // top of each plan's first unavailable row — null when the plan has none
      const ys = plans.map((p) => {
        const off = p.querySelector<HTMLElement>(".row.off");
        return off ? off.getBoundingClientRect().top - box.top : null;
      });
      const pts: [number, number][] = [];
      plans.forEach((p, i) => {
        const y = ys[i];
        if (y == null) return;
        const r = p.getBoundingClientRect();
        if (!pts.length) pts.push([r.left - box.left, y]);
        pts.push([r.right - box.left, y]);
        pts.push([r.right - box.left, ys[i + 1] ?? box.height]);
      });
      setD(pts.map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join(" "));
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, d };
}

// Monochrome marks for the coding agents — same stand-ins as the live page.
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

const HERO_AGENTS = [
  { name: "Claude Code", mark: <ClaudeMark /> },
  { name: "Codex", mark: <CodexMark /> },
  { name: "Cursor", mark: <CursorMark /> },
];

// The live page's CTA, unchanged — design-system button + agent switcher.
function CopyPrompt({ accent, switcher }: { accent?: boolean; switcher?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [sel, setSel] = useState(0);
  const [open, setOpen] = useState(false);
  const current = HERO_AGENTS[sel];
  const label = switcher ? "Setup for agents" : "Copy prompt for your AI";
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
        {copied ? <><Check size={15} /> {copiedLabel}</> : <><Copy size={15} /> {label}</>}
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

export default function Page() {
  const [machine, setMachine] = useState(false);
  const planStep = usePlanStep();
  const artRef = useRef<HTMLElement>(null);
  // The nav is knocked out while it sits on the picture and solid once it has
  // scrolled off it. The observer watches the picture through a viewport whose
  // top edge is pushed down by the nav's own height, so the flip lands exactly
  // when the bar clears the artwork.
  const [solid, setSolid] = useState(false);
  useEffect(() => {
    const el = artRef.current;
    if (!el) return;
    const navh = parseInt(getComputedStyle(el).getPropertyValue("--navh")) || 62;
    const io = new IntersectionObserver(
      ([entry]) => setSolid(!entry.isIntersecting),
      { rootMargin: `-${navh}px 0px 0px 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  if (machine) {
    return (
      <div className="ss">
        <MachineView />
        <ModeToggle machine onToggle={() => setMachine(false)} />
      </div>
    );
  }

  return (
    <div className="ss">
      <main className="wrap">
        {/* the nav, same markup as ever — knocked out while it's on the
            picture, back to the blurred paper bar once it has left it */}
        <nav className={"nav" + (solid ? " solid" : "")}>
          <a className="brand" href="/"><span className="mk"><Mark size={15} onDark /></span>Supersonic</a>
          <div className="links">
            <a href="#features">Product</a>
            <a href="#pricing">Pricing</a>
          </div>
          <span className="spacer" />
          <a className="btn ghost sm" href={APP}>Open app</a>
          <a className="btn accent sm" href={`${APP}/signup`}>Sign up</a>
        </nav>

        {/* HERO PICTURE — flush to the guide lines, running under the nav */}
        <section className="ss-art" ref={artRef}>
          <img src="/hero-sf.jpg" alt="San Francisco at sunset, seen across the bay from the Golden Gate" />
        </section>

        <section className="ss-headline">
          <div>
            <h1>Domain, database, server<br />from one prompt</h1>
          </div>
          <div className="ss-aside">
            <p>
              The cloud for AI era. Point us at the app you built and we turn it
              into a real, live product in one click
            </p>
            <div className="actions">
              <CopyPrompt accent switcher />
            </div>
          </div>
        </section>

        {/* ——— everything below is the current page, untouched, for comparison ——— */}
        <section className="sec cli-sec">
          <div className="sec-head">
            <h2>Ready in one CLI command</h2>
            <p>One command, from your project folder. We work out how the app runs, build it, and hand back a live URL.</p>
          </div>
          <CommandBlock />
        </section>

        <section className="sec" id="features">
          <div className="sec-head">
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

        <section className="sec roles-sec" id="collaborate">
          <div className="sec-head">
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
        </section>

        <section className="sec agent-sec">
          <div className="agent-copy">
            <h2>Something breaks at 2am?<br />It&apos;s already fixed.</h2>
            <p>Supersonic runs its own AI inside your cloud. It watches your live app, and the moment something fails it <b>reads your code, writes the fix, and redeploys to green</b> — on its own. You wake up to a working app and a changelog.</p>
            {/* <div className="agent-flow">
              <span className="af">Detects the error</span><ArrowRight size={14} />
              <span className="af">Reads the code</span><ArrowRight size={14} />
              <span className="af">Writes the fix</span><ArrowRight size={14} />
              <span className="af on">Redeploys ✓</span>
            </div> */}
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

        <section className="sec globe-sec">
          <div className="copy">
            <h2>Deploy anywhere.<br />Live everywhere.</h2>
            <p>Every app ships to Google&apos;s global network with a secure custom domain and auto-scaling — fast for the person next door and the one across the planet.</p>
            <div className="cities">
              <span>San Francisco</span><span>New York</span><span>London</span><span>Berlin</span><span>Tokyo</span><span>Singapore</span><span>Sydney</span>
            </div>
          </div>
          <div className="stage"><Globe /></div>
        </section>

        <section className="sec" id="pricing">
          <div className="sec-head">
            <h2>Try it free.<br />No infrastructure bills.</h2>
            <p>Your cloud is included and you never touch a Google Cloud invoice.</p>
            <div className="trialbar">14 days free on every plan · no card to start · cancel any time</div>
          </div>
          <div className="compare" ref={planStep.ref}>
            <svg className="plan-step" width="100%" height="100%" aria-hidden>
              <path d={planStep.d} />
            </svg>
            <div className="plan">
              <div className="pname">Basic</div>
              <div className="pdesc">Ship one app, share it with your team, and get paste-ready fixes for your coding agent.</div>
              <div className="price"><b>$12</b> / month</div>
              {basic.map(([label, on]) => (
                <div className={"row" + (on ? "" : " off")} key={String(label)}>
                  <span className="mk">{on ? <Check size={15} strokeWidth={2.2} /> : <X size={14} />}</span>{label}
                </div>
              ))}
              <div className="cta"><a className="btn ghost" href={`${APP}/new`}>Start free trial</a></div>
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
              <div className="cta"><a className="btn ghost" href={`${APP}/new`}>Start free trial</a></div>
            </div>
            <div className="plan">
              <div className="pname">Scale</div>
              <div className="pdesc">Everything in Pro, plus analytics for your live app and an agent that fixes production code on its own.</div>
              <div className="price"><b>$40</b> / month</div>
              {scale.map(([label, on]) => (
                <div className={"row" + (on ? "" : " off")} key={String(label)}>
                  <span className="mk">{on ? <Check size={15} strokeWidth={2.2} /> : <X size={14} />}</span>{label}
                </div>
              ))}
              <div className="cta"><a className="btn accent" href={`${APP}/new`}>Go Scale <ArrowRight size={15} /></a></div>
            </div>
          </div>
        </section>

        <section className="sec faq-sec">
          <div className="lead">
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

        <section className="sec final">
          <h2 style={{ marginTop: 14 }}>Ship your first app today.</h2>
          <div className="cta ss-final-cta"><CopyPrompt accent switcher /></div>
        </section>

        <footer>
          <div className="foot">
            <div>
              <div className="brand"><span className="mk"><Mark size={15} onDark /></span>SUPERSONIC</div>
              <p style={{ color: "var(--ink-2)", fontSize: 13, marginTop: 12, maxWidth: "30ch" }}>The cloud for AI era. Deploy anything in one click.</p>
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
            <span>© 2026 Supersonic Software, Inc.</span>
            <span className="spacer" />
            <span>London, UK</span>
          </div>
        </footer>
      </main>

      <ModeToggle machine={false} onToggle={() => setMachine(true)} />

      <a className="ss-badge" href={APP} target="_blank" rel="noreferrer">
        <Mark size={12} onDark />Runs on Supersonic
      </a>
    </div>
  );
}
