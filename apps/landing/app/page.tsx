"use client";

// Bay — the landing page.
//
// Written 19 Aug as /home, beside the page it was meant to replace, and moved
// here on 24 Aug when the rename started for real. The old page is in git; it
// is not worth a route.
//
// Everything visual lives in `home.css`; this file is structure and words.
//
// The shape is openwebui.com and cursor.com/home: left-aligned, small type, a
// hero that is mostly empty space, and pictures that are their own blocks under
// it rather than something the headline sits on top of. Geist throughout — no
// second typeface. The accent is the brand red and it appears on the arrow
// links and the brand chip, nowhere else.

import { useEffect, useLayoutEffect, useState } from "react";
import "./home.css";
import { ArrowRight, ArrowUpRight, Check, Copy } from "lucide-react";
import { Mark } from "@/components/Mark";
import { Terminal, AnimatedSpan } from "@/components/magicui/terminal";

// The four strings the rename turns on now live in lib/brand.ts, where the
// control plane has the same seam. APP_URL still points at the old host on
// purpose: app.thebay.cloud exists but its certificate is still being issued,
// and a button that leads nowhere is worse than one that leads to the old name.
import { BRAND, DOMAIN, CLI, APP_URL as APP, CONTACT_EMAIL } from "@/lib/brand";

// Product language, from CONTEXT.md. Every word is one a ten-year-old knows.
const PAIRS = [
  {
    eyebrow: "Built for one person",
    body: `Point ${BRAND} at the folder you are already standing in. It comes back with an address you can send to somebody, a database that was already running, and nothing for you to configure. No repository required.`,
    link: { label: "How shipping works", href: "#ship" },
  },
  {
    eyebrow: "Built for the team they hire",
    body: `Sign in with your company domain, hand out roles, read the audit log. You pay for the people who build and never for the people who use — an internal tool that charges per viewer is a tool nobody opens.`,
    link: { label: "See pricing", href: "#pricing" },
  },
];

// These are product facts, not traction. Nothing here is a number we do not
// have: swap them for downloads and stars the day those exist.
const FIGURES = [
  { n: "~40s", l: "from one command to a live address" },
  { n: "1", l: "command to ship, and no config file to write" },
  { n: "$0", l: "to keep three real apps online, with no clock on them" },
];

const PLANS = [
  {
    name: "Free",
    price: "$0",
    unit: "forever",
    desc: "Three real apps with a database, an address, and the people you share them with.",
    rows: ["3 apps", "Database and storage included", "Share with anyone by email", "One public app"],
    cta: "Start free",
    href: `${APP}/new`,
    fill: false,
  },
  {
    name: "Pro",
    price: "$20",
    unit: "per month",
    desc: "Unlimited apps, a domain of your own, and a failed ship that fixes itself and goes back to green.",
    rows: ["Everything in Free, unlimited", "Your own domain", "Auto-fix every failed build", `No ${BRAND} badge`, "Backups and undo"],
    cta: "Go Pro",
    href: `${APP}/new`,
    fill: true,
  },
  {
    name: "Team",
    price: "Let's talk",
    unit: "",
    desc: "For a team whose internal tools all live in one place, with the people who use them free.",
    rows: ["Everything in Pro", "Sign in with your company domain", "Roles and an audit log", "Unlimited recipients, always free"],
    cta: "Talk to us",
    href: `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`${BRAND} Team plan`)}`,
    fill: false,
  },
];

// ── the command line ───────────────────────────────────────────────────────

function CommandLine() {
  const [copied, setCopied] = useState(false);
  const cmd = `npx ${CLI} deploy`;

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div className="b-cmd">
      <code>
        <span className="b-dollar">$ </span>
        {cmd}
      </code>
      <button
        type="button"
        className={"b-cmd-copy" + (copied ? " b-done" : "")}
        aria-label={copied ? "Copied" : "Copy command"}
        onClick={() => {
          navigator.clipboard?.writeText(cmd).then(() => setCopied(true)).catch(() => {});
        }}
      >
        {copied ? <Check size={14} strokeWidth={2.4} /> : <Copy size={13.5} strokeWidth={2} />}
      </button>
    </div>
  );
}

// ── reveal ─────────────────────────────────────────────────────────────────

// The section is armed here rather than in the stylesheet. Hiding it in CSS
// would mean a page that stays blank whenever this never runs, and that includes
// a failed hydration and every crawler. Arming in a layout effect happens before
// the first paint, so nothing flashes.
function useRise() {
  useLayoutEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(".bay .b-rise"));
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced || !("IntersectionObserver" in window)) return;

    els.forEach((el) => el.classList.add("b-armed"));

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("b-in");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.05 }
    );
    els.forEach((el) => io.observe(el));

    // Last resort. If the observer has not fired after a couple of seconds, the
    // reveal is no longer worth the risk of hiding real copy.
    const failsafe = setTimeout(() => els.forEach((el) => el.classList.add("b-in")), 2500);

    return () => {
      io.disconnect();
      clearTimeout(failsafe);
    };
  }, []);
}

// ── the page ───────────────────────────────────────────────────────────────

export default function Home() {
  const [stuck, setStuck] = useState(false);
  useRise();

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const brand = (
    <>
      <span className="b-chip">
        <Mark size={15} onDark />
      </span>
      <span className="b-word">{BRAND}</span>
    </>
  );

  return (
    <div className="bay">
      <nav className={"b-nav" + (stuck ? " b-stuck" : "")}>
        <div className="b-wrap">
          <a className="b-brand" href="/home" aria-label={`${BRAND} home`}>
            {brand}
          </a>
          <div className="b-nav-links">
            <a href="#ship">Product</a>
            <a href="#agents">For agents</a>
            <a href="#pricing">Pricing</a>
            <a href="/llms.txt">Docs</a>
          </div>
          <div className="b-spacer" />
          <div className="b-nav-right">
            <a className="b-btn b-btn-quiet b-btn-sm" href={APP}>
              Sign in
            </a>
            <a className="b-btn b-btn-fill b-btn-sm" href={`${APP}/new`}>
              Get started
            </a>
          </div>
        </div>
      </nav>

      {/* ── hero ─────────────────────────────────────────────────────── */}

      <header className="b-hero">
        <div className="b-wrap">
          <h1>A cloud for small software.</h1>
          <p className="b-body">
            Point it at the app you built. It comes back a real product — its own address, a
            database, a way in for the people you choose — in about forty seconds.
          </p>
          <div className="b-hero-cta">
            <a className="b-btn b-btn-fill" href={`${APP}/new`}>
              Get started <ArrowRight size={15} strokeWidth={2} />
            </a>
            <CommandLine />
          </div>
          <div className="b-hero-note">
            <a className="b-arrow" href="#pricing">
              Free plan, no card, no clock <ArrowRight size={15} strokeWidth={2} />
            </a>
          </div>
        </div>
      </header>

      {/* ── the picture ──────────────────────────────────────────────── */}

      <section>
        <div className="b-wrap">
          <div className="b-plate">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/hero-sf.jpg" alt="The Golden Gate and the city, from the bay." fetchPriority="high" />
          </div>
          <p className="b-caption">The Golden Gate, looking east toward the city.</p>
        </div>
      </section>

      {/* ── what it is ───────────────────────────────────────────────── */}

      <section className="b-sec">
        <div className="b-wrap b-two b-rise">
          <h2>Everything on, from the first ship.</h2>
          <div>
            <p className="b-body">
              There is no step where you go and set something up. Every app opens at a name you
              can send to somebody, its database is saved and backed up from the first click, and
              we watch the live thing around the clock and tell you what broke in words rather
              than an error code.
            </p>
            <div className="b-two-links">
              <a className="b-arrow" href="#ship">
                How shipping works <ArrowRight size={15} strokeWidth={2} />
              </a>
              <a className="b-arrow" href="#agents">
                Drive it from your agent <ArrowRight size={15} strokeWidth={2} />
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── figures ──────────────────────────────────────────────────── */}

      <section className="b-sec" style={{ paddingTop: 0 }}>
        <div className="b-wrap b-rise">
          <span className="b-eyebrow">The shape of it</span>
          <div className="b-figures">
            {FIGURES.map((f) => (
              <div key={f.n}>
                <div className="b-fig-n">{f.n}</div>
                <p className="b-fig-l">{f.l}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── ship ─────────────────────────────────────────────────────── */}

      <section className="b-sec" id="ship">
        <div className="b-wrap b-two b-rise">
          <div>
            <h2>One command, and it&apos;s out.</h2>
            <p className="b-body" style={{ marginTop: 18 }}>
              Run it in the folder you are already standing in. {BRAND} reads the app, works out
              how to run it, and tells you the address when it answers. Your .env travels with
              it, and every app is private until you say otherwise.
            </p>
            <div className="b-two-links">
              <a className="b-arrow" href="/llms.txt">
                Read the manual <ArrowUpRight size={15} strokeWidth={2} />
              </a>
            </div>
          </div>
          <div className="b-card">
            <Terminal title={CLI}>
              <AnimatedSpan delay={100} className="term-cmd">
                $ {CLI} deploy
              </AnimatedSpan>
              <AnimatedSpan delay={600}>
                reading the app <span className="term-key">next.js · node 22</span>
              </AnimatedSpan>
              <AnimatedSpan delay={1050}>
                building <span className="term-key">41s</span>
              </AnimatedSpan>
              <AnimatedSpan delay={1500}>
                database <span className="term-key">ready</span>
              </AnimatedSpan>
              <AnimatedSpan delay={1950}>
                address <span className="term-key">reserved</span>
              </AnimatedSpan>
              <AnimatedSpan delay={2450} className="term-ok">
                ✓ live: <span className="term-url">https://harbor.{DOMAIN}</span>
              </AnimatedSpan>
            </Terminal>
          </div>
        </div>
      </section>

      {/* ── who it is for ────────────────────────────────────────────── */}

      <section className="b-sec" style={{ paddingTop: 0 }}>
        <div className="b-wrap b-rise">
          <h2>One person, or the team they hire.</h2>
          <div className="b-cols">
            {PAIRS.map((p) => (
              <div key={p.eyebrow}>
                <span className="b-eyebrow">{p.eyebrow}</span>
                <p>{p.body}</p>
                <a className="b-arrow" href={p.link.href}>
                  {p.link.label} <ArrowRight size={15} strokeWidth={2} />
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── agents ───────────────────────────────────────────────────── */}

      <section className="b-sec" id="agents">
        <div className="b-wrap b-two b-rise">
          <div>
            <h2>Your agent can drive it.</h2>
            <p className="b-body" style={{ marginTop: 18 }}>
              {BRAND} ships as a command and as an MCP server, so the thing writing your code can
              also put it online, read what production actually saw, and go fix what it finds —
              without handing you a stack trace and asking what to do.
            </p>
            <div className="b-two-links">
              <a className="b-arrow" href="/llms.txt">
                The agent manual <ArrowUpRight size={15} strokeWidth={2} />
              </a>
            </div>
          </div>
          <div className="b-card-plain">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/bridge.jpg" alt="" aria-hidden />
          </div>
        </div>
      </section>

      {/* ── pricing ──────────────────────────────────────────────────── */}

      <section className="b-sec" id="pricing" style={{ paddingTop: 0 }}>
        <div className="b-wrap b-two b-rise" style={{ alignItems: "end" }}>
          <h2>Free forever. No infrastructure bill.</h2>
          <p className="b-body">
            Your cloud is included and you never see a Google Cloud invoice. Apps on the free
            plan do not sleep and do not expire.
          </p>
        </div>
        <div className="b-wrap b-rise">
          <div className="b-plans">
            {PLANS.map((p) => (
              <div className="b-plan" key={p.name}>
                <div className="b-plan-name">{p.name}</div>
                <div className={"b-plan-price" + (p.unit ? "" : " b-plan-words")}>
                  {p.price} {p.unit ? <span>/ {p.unit}</span> : null}
                </div>
                <p className="b-plan-desc">{p.desc}</p>
                <ul>
                  {p.rows.map((r) => (
                    <li key={r}>
                      <Check size={14} strokeWidth={2.2} />
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
                <a className={"b-btn " + (p.fill ? "b-btn-fill" : "b-btn-line")} href={p.href}>
                  {p.cta}
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── closing ──────────────────────────────────────────────────── */}

      <section className="b-close">
        <div className="b-wrap b-rise">
          <h2>Bring it in to the bay.</h2>
          <div className="b-hero-cta">
            <a className="b-btn b-btn-fill" href={`${APP}/new`}>
              Get started <ArrowRight size={15} strokeWidth={2} />
            </a>
            <CommandLine />
          </div>
        </div>
      </section>

      {/* ── footer ───────────────────────────────────────────────────── */}

      <footer className="b-foot">
        <div className="b-wrap">
          <div className="b-foot-brand">
            <a className="b-brand" href="/home">
              {brand}
            </a>
            <p>A cloud for small software.</p>
          </div>
          <div className="b-spacer" />
          <div className="b-fcol">
            <span className="b-eyebrow">Product</span>
            <a href="#ship">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#agents">For agents</a>
          </div>
          <div className="b-fcol">
            <span className="b-eyebrow">Build</span>
            <a href="/llms.txt">Agent manual</a>
            <a href={`${APP}/new`}>Ship an app</a>
            <a href={APP}>Sign in</a>
          </div>
          <div className="b-fcol">
            <span className="b-eyebrow">Company</span>
            <a href={`mailto:${CONTACT_EMAIL}`}>Contact</a>
            <a href="https://github.com/The-Red-Onion" rel="noreferrer">
              GitHub
            </a>
          </div>
          <div className="b-foot-bar">
            <span>
              © {new Date().getFullYear()} {BRAND} Cloud
            </span>
            <span>{DOMAIN}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
