"use client";

// Bay: the landing page, under the new name.
//
// Built alongside the Supersonic page rather than over it: /home is the whole
// page, / is untouched.
//
// Tailwind, with the palette named in tailwind.config.ts as ground / tile /
// line / ink / brand / live, from docs/HANDOFF-panel.md §4. `home.css` holds
// only the three things utilities cannot reach: the <body> override, ::selection
// and the reveal. Nothing else belongs in it.
//
// The type is openwebui.com and cursor.com/home. The feature blocks are
// agentnotes.cc: each one its own near-full-screen panel, the mock on a second
// tinted ground inside it, and a real button at the end.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, Check, Copy, Lock, Terminal } from "lucide-react";
import { Mark } from "@/components/Mark";
import { cn } from "@/lib/utils";
import { Dithering, MeshGradient } from "@paper-design/shaders-react";
import { APP_URL, BRAND, CLI, DOCS_URL, DOMAIN, GITHUB_REPO, GITHUB_URL, PKG } from "@/lib/brand";
import { TEMPLATES } from "@/lib/templates";
import { onboardPrompt, selfhostPrompt } from "@/lib/prompts";
import { Stars } from "@/components/Stars";
import { NAV_H, SiteNav } from "@/components/SiteNav";
import { LanguagePicker } from "@/components/LanguagePicker";
import { CopyPrompt } from "@/components/CopyPrompt";
import { PromptDialog } from "@/components/PromptDialog";
import { fill, localePath, type Locale, type Messages } from "@/lib/i18n";



// ── repeated class strings ─────────────────────────────────────────────────
//
// Named where a utility string is spent more than twice, so a button is one edit
// rather than nine. Anything used once stays inline where it is read.

const WRAP = "mx-auto w-full max-w-[1200px] px-[22px] min-[900px]:px-10";
const SECTION = "py-[clamp(72px,8.5vw,120px)]";

const BTN =
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[6px] " +
  "border border-transparent px-[18px] font-sans text-[15px] font-[450] tracking-[-0.01em] " +
  "h-10 transition-colors";
// A darker rim rather than a lighter one. brand-deep (#fc8779) is what the panel
// documents for borders, but it sits ON a tint there; over the solid fill on a
// near-white page it washed out. brand-ink (#b32c1a) is the same family, already
// a token, and actually draws an edge.
const BTN_FILL =
  "border-brand-ink bg-brand text-[#ffffff] hover:border-[#8f2313] hover:bg-[#cf3522]";
const BTN_LINE = "border-line bg-white text-ink hover:bg-tile";
const BTN_SM = "h-[34px] px-[14px] text-[14px]";

// The accent lives on these and very nearly nowhere else. cursor.com puts its one
// warm colour on exactly the links that carry you deeper, and nothing else on the
// page competes with them.
const ARROW =
  "group inline-flex items-center gap-[7px] text-[15px] text-brand-ink transition-colors hover:text-brand";
const ARROW_ICON = "transition-transform group-hover:translate-x-[3px]";

const BODY = "max-w-[54ch] text-pretty text-[17px] leading-[1.6] text-ink-2";
const H2 =
  "m-0 font-sans text-balance text-[clamp(25px,2.4vw,31px)] font-normal leading-[1.16] tracking-[-0.022em]";

// Two grounds for the mock to sit on, alternating down the page. Both are kept
// far below the accent's saturation, so they read as tinted paper and the page
// still has exactly one accent.
const TINT = {
  warm: "bg-[linear-gradient(150deg,#f7e4de_0%,#f3ddd6_55%,#efd6cd_100%)]",
  cool: "bg-[linear-gradient(150deg,#dfe6f0_0%,#d8e1ee_55%,#d2dcea_100%)]",
};

// ── mock chrome ────────────────────────────────────────────────────────────

// A drawing of the product, not a working one. `bleed` widens it past its frame
// so it runs off the right edge. A flipped block keeps it inside instead, because
// bleeding leftward clips the row labels, which are the half carrying the meaning.
function Win({
  url,
  title,
  bleed,
  children,
}: {
  url?: string;
  title?: string;
  bleed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "min-h-[300px] shrink-0 overflow-hidden rounded-t-[6px] border border-black/[0.07]",
        "bg-white text-[13px] min-[900px]:min-h-[360px]",
        bleed
          ? "w-full border-r-0 shadow-[-14px_-14px_40px_-18px_rgba(20,20,40,0.22)] min-[900px]:w-[128%]"
          : "w-full shadow-[0_-14px_40px_-18px_rgba(20,20,40,0.20)]"
      )}
    >
      <div className="flex h-9 items-center gap-[10px] border-b border-line px-[13px]">
        <div className="flex shrink-0 gap-[5px]">
          <span className="size-2 rounded-full bg-[#dcdcdc]" />
          <span className="size-2 rounded-full bg-[#dcdcdc]" />
          <span className="size-2 rounded-full bg-[#dcdcdc]" />
        </div>
        {url ? (
          <span className="flex h-[22px] max-w-[260px] items-center gap-[7px] rounded-full bg-ground px-[10px] font-mono text-[11.5px] text-ink-2">
            <Lock size={10} strokeWidth={2.5} className="shrink-0 text-live" />
            {url}
          </span>
        ) : null}
        {title ? <span className="font-mono text-[11.5px] text-ink-3">{title}</span> : null}
      </div>
      <div className="px-4 pb-[22px] pt-4">{children}</div>
    </div>
  );
}


// The who-can-open-it picker. `on` is the selected state.
function Opt({ t, d, on }: { t: string; d: string; on?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-start gap-[11px] rounded-[4px] border border-transparent px-3 py-[11px]",
        on && "border-brand-deep bg-brand/[0.06]"
      )}
    >
      <span
        className={cn(
          "mt-[3px] size-[14px] shrink-0 rounded-full bg-white",
          on ? "border-4 border-brand" : "border-[1.5px] border-[#d6d6d6]"
        )}
      />
      <span>
        <span className="block text-[13.5px] text-ink">{t}</span>
        <span className="mt-0.5 block text-[12px] text-ink-3">{d}</span>
      </span>
    </div>
  );
}

// Preformatted, so the columns the mock lines up in survive.
const CODE = "overflow-hidden whitespace-pre font-mono text-[11.5px] leading-[1.85] text-ink-2";
const KEY = "font-medium text-ink";
const DIM = "text-ink-3";


// A recording of the real product, framed like the drawn mocks beside it.
//
// No `Win` chrome around it: these are captures of a browser and already carry
// their own address bar and tabs, so the fake one would be a second window
// drawn around a real one.
//
// Muted, looping, playsInline and preload="none" are what make autoplay legal
// on iOS and in Chrome and keep the file off the critical path. The poster is a
// real frame, so first paint and first playable frame are the same picture, and
// it stands in on its own where the system asks for less motion.
function Clip({ src, bleed, alt }: { src: string; bleed: boolean; alt: string }) {
  return (
    <div
      className={cn(
        "shrink-0 overflow-hidden rounded-t-[6px] border border-black/[0.07] bg-white",
        bleed
          ? "w-full border-r-0 shadow-[-14px_-14px_40px_-18px_rgba(20,20,40,0.22)] min-[900px]:w-[128%]"
          : "w-full shadow-[0_-14px_40px_-18px_rgba(20,20,40,0.20)]"
      )}
    >
      <video
        aria-label={alt}
        autoPlay
        className="block aspect-[16/10] w-full object-cover object-top motion-reduce:hidden"
        loop
        muted
        playsInline
        poster={`/demo/${src}-poster.jpg`}
        preload="none"
        tabIndex={-1}
      >
        <source src={`/demo/${src}.mp4`} type="video/mp4" />
      </video>
      <div
        aria-hidden
        className="hidden aspect-[16/10] w-full bg-cover bg-top motion-reduce:block"
        style={{ backgroundImage: `url(/demo/${src}-poster.jpg)` }}
      />
    </div>
  );
}

// ── the features ───────────────────────────────────────────────────────────

// Structure only. The heading and the sentence live in the catalogues, keyed by
// `id`, so a translation cannot silently drop a block and the Product menu keeps
// linking to the same anchor whatever language it is read in.
const FEATURES: {
  /** Stable anchor for the Product menu, and the catalogue key. Not derived from
   *  the heading, so rewording a feature does not break the link to it. */
  id: "ship" | "services" | "fixes";
  tint: keyof typeof TINT;
  mock: (bleed: boolean) => React.ReactNode;
}[] = [
  {
    id: "ship",
    tint: "warm",
    // Simulated terminal output, and it stays English: the CLI speaks English
    // and a half-translated terminal is worse than an English one.
    mock: (bleed) => (
      <Win title={CLI} bleed={bleed}>
        <div className={CODE}>
          <span className={KEY}>$ {CLI} ship</span>
          {"\n"}reading the app   <span className={KEY}>next.js · node 22</span>
          {"\n"}building          <span className={KEY}>41s</span>
          {"\n"}database         <span className={KEY}>ready</span>
          {"\n"}
          <span className={DIM}>✓ live: https://harbor.{DOMAIN}</span>
        </div>
      </Win>
    ),
  },
  {
    id: "services",
    tint: "cool",
    // The Data screen, recorded. It shows the tables an app got without anyone
    // provisioning them, which is the claim the heading makes.
    mock: (bleed) => <Clip alt="The Data screen listing tables Bay provisioned" bleed={bleed} src="services" />,
  },
  {
    id: "fixes",
    tint: "warm",
    // A ship that did not land, and the app screen offering the fix. The drawn
    // version of this said the same thing; this one happened.
    mock: (bleed) => <Clip alt="A failed ship, and the fix offered for it" bleed={bleed} src="fix" />,
  },
];

// ── how you talk to it ─────────────────────────────────────────────────────

// The CLI and MCP are not features alongside the others, they are the two ways
// in. So this gets its own surface: one dark band, full width, breaking the light
// page deliberately. The design system is light-only by decision (dark mode was
// dropped, not carried) so this is an accent surface, not a theme.
//
// The two cards are modelled on ui.shadcn.com/docs/cli (package-manager tabs
// above a command block, then the commands listed with one-line descriptions)
// and on Refero's MCP card (a gradient panel of connected tools above a white
// body). Both cards are light so they read as a pair against the dark band.

// Order matches the shadcn docs: pnpm first.
const PMS: [string, string][] = [
  ["pnpm", `pnpm dlx ${PKG}@latest deploy`],
  ["npm", `npx ${PKG}@latest deploy`],
  ["yarn", `yarn dlx ${PKG}@latest deploy`],
  ["bun", `bunx ${PKG}@latest deploy`],
];

// The command names are the product's own and are never translated. Their
// one-line descriptions are, and they are keyed by the name.
const COMMANDS = ["ship", "logs", "errors", "diagnose", "rollback", "env", "exec"] as const;

// The clients that speak MCP. Icons are real files in public/logos, downloaded
// once from logo.dev rather than fetched from their API at runtime: a landing
// page should not have a third party in its critical path.
//
// Sizes, positions and tints all vary on purpose. A ring of identical white
// tiles reads as a diagram; an uneven scatter of tinted glass reads as a board,
// which is what the reference does. `tint` is a translucent wash over the mesh
// behind it, so the ground shows through every tile.
const MCP_CLIENTS: {
  name: string;
  file: string;
  left: string;
  top: string;
  size: number;
  tint: string;
  /** How much of the tile the icon fills, in %. Marks with a baked-in
   *  background want more; transparent marks want an inset. */
  icon: number;
}[] = [
  { name: "Claude Code", file: "claude", left: "84%", top: "23%", size: 66, tint: "bg-[#efdcc4]/70", icon: 56 },
  { name: "Cursor", file: "cursor", left: "61%", top: "15%", size: 48, tint: "bg-[#c8cedd]/60", icon: 64 },
  { name: "Codex", file: "openai", left: "31%", top: "27%", size: 44, tint: "bg-[#ffffff]/75", icon: 56 },
  { name: "Zed", file: "zed", left: "13%", top: "63%", size: 70, tint: "bg-[#d9d3c7]/70", icon: 74 },
  { name: "Windsurf", file: "windsurf", left: "70%", top: "69%", size: 54, tint: "bg-[#bcc9ee]/55", icon: 72 },
  { name: "VS Code", file: "vscode", left: "91%", top: "77%", size: 42, tint: "bg-[#d3c4ee]/55", icon: 62 },
];

// Traces, in the panel's own coordinates. Orthogonal on purpose: right angles
// survive preserveAspectRatio="none" (scaling x and y independently keeps
// horizontals horizontal), and non-scaling-stroke keeps the line weight even
// once they are stretched. Not every trace reaches the mark, and some just end,
// because a board has runs on it that are not about you.
const TRACES = [
  "M 30 78 H 158 V 30 H 322",
  "M 158 78 V 206 H 344",
  "M 300 128 H 468 V 58",
  "M 236 178 H 402 V 234 H 534",
  "M 452 152 H 540",
  "M 58 146 H 116 V 244 H 250",
  "M 322 30 V 96",
];

// Pads sitting on the traces. Absolutely positioned rather than drawn in the
// SVG, so they stay square when the panel stretches.
const PADS: { left: string; top: string; c: string }[] = [
  { left: "28%", top: "11%", c: "bg-[#c9b6f0]/70" },
  { left: "5%", top: "29%", c: "bg-[#a9c7f5]/70" },
  { left: "57%", top: "11%", c: "bg-[#e8d6b8]/80" },
  { left: "53%", top: "36%", c: "bg-[#bcd9a8]/70" },
  { left: "83%", top: "48%", c: "bg-[#bcd9a8]/70" },
  { left: "28%", top: "48%", c: "bg-[#c9b6f0]/70" },
  { left: "41%", top: "77%", c: "bg-[#e8d6b8]/80" },
  { left: "95%", top: "56%", c: "bg-[#f0c2d8]/70" },
  { left: "63%", top: "87%", c: "bg-[#d8d2c8]/80" },
];

// The icon, or its monogram if the file is not there yet. Without the fallback a
// missing download leaves six broken-image glyphs, which looks like a bug rather
// than a pending asset.
function LogoTile({ c }: { c: (typeof MCP_CLIENTS)[number] }) {
  const [failed, setFailed] = useState(false);
  const initials = c.name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2);

  return (
    <span
      style={{ left: c.left, top: c.top, width: c.size, height: c.size }}
      title={c.name}
      className={cn(
        "absolute grid -translate-x-1/2 -translate-y-1/2 place-items-center overflow-hidden",
        "rounded-[26%] border border-[#ffffff]/60 shadow-[0_8px_22px_-6px_rgba(90,55,25,0.32)] backdrop-blur-[3px]",
        c.tint
      )}
    >
      {failed ? (
        <span className="text-[13px] font-semibold tracking-tight text-[#737373]">{initials}</span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/logos/${c.file}.png`}
          alt={c.name}
          width={c.size}
          height={c.size}
          onError={() => setFailed(true)}
          style={{ width: `${c.icon}%`, height: `${c.icon}%` }}
          className="object-contain"
        />
      )}
    </span>
  );
}

function CliCard({ t }: { t: Messages }) {
  const [pm, setPm] = useState(0);
  const [copied, setCopied] = useState(false);
  const cmd = PMS[pm][1];

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-[12px] bg-white">
      <div className="px-6 pb-5 pt-6">
        <div className="text-[15px] font-medium text-ink">{t.interfaces.cli.title}</div>
        <p className="mt-1.5 text-[14px] leading-[1.5] text-ink-2">
          {t.interfaces.cli.p}
        </p>
      </div>

      {/* The command block from ui.shadcn.com/docs/cli, followed closely: one
          light container, a dark terminal glyph, the package managers as tabs
          with the active one a white pill, a hairline, then the command itself in
          dark mono on the same light ground. No dark code block anywhere. */}
      <div className="mx-6 overflow-hidden rounded-[14px] border border-line bg-tile">
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <span className="grid size-[26px] shrink-0 place-items-center rounded-[7px] bg-ink text-white">
            <Terminal size={14} strokeWidth={2.2} />
          </span>
          <div className="flex items-center gap-0.5" role="tablist" aria-label={t.interfaces.cli.pmAria}>
            {PMS.map(([name], i) => (
              <button
                key={name}
                role="tab"
                type="button"
                aria-selected={i === pm}
                onClick={() => setPm(i)}
                className={cn(
                  "rounded-[9px] px-2.5 py-1 font-mono text-[13px] transition-colors",
                  i === pm
                    ? "border border-line bg-white text-ink shadow-[0_1px_2px_rgba(0,0,0,0.05)]"
                    : "border border-transparent text-ink-3 hover:text-ink-2"
                )}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <button
            type="button"
            aria-label={copied ? t.interfaces.cli.copiedAria : t.interfaces.cli.copyAria}
            onClick={() => {
              navigator.clipboard?.writeText(cmd).then(() => setCopied(true)).catch(() => {});
            }}
            className={cn(
              "grid size-7 shrink-0 place-items-center rounded-[6px] transition-colors hover:bg-black/[0.05]",
              copied ? "text-live" : "text-ink-3 hover:text-ink"
            )}
          >
            {copied ? <Check size={15} strokeWidth={2.4} /> : <Copy size={14.5} strokeWidth={2} />}
          </button>
        </div>
        <div className="overflow-x-auto border-t border-line px-4 py-3.5">
          <code className="whitespace-pre font-mono text-[13px] text-ink">{cmd}</code>
        </div>
      </div>

      {/* flex-1 so this card can be the same height as the MCP one beside it
          without the list floating in the middle of the space. */}
      <div className="mt-5 flex-1 border-t border-line px-6 py-5">
        <div className="flex flex-col gap-2">
          {COMMANDS.map((c) => (
            <div key={c} className="flex items-baseline gap-3 text-[12.5px]">
              <code className="w-[104px] shrink-0 font-mono text-ink">
                {CLI} {c}
              </code>
              <span className="text-ink-2">{t.interfaces.commands[c]}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function useShaderGround() {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    try {
      const c = document.createElement("canvas");
      setOk(Boolean(c.getContext("webgl2") ?? c.getContext("webgl")));
    } catch {
      setOk(false);
    }
  }, []);
  return ok;
}

// ── the dither backdrop ────────────────────────────────────────────────────

// A Bayer-dithered wave: a waveform rendered as print halftone. Lifted from
// speko-landing's src/components/viz/backdrop.tsx, with the brand red in place
// of its blue, and masked to the section's SIDES so the two cards sit on clean
// ground and the texture lives in the margins.
//
// Two layers, and the order matters:
//   1. A CSS dot field on a 7px pitch. No GPU, in the server-rendered HTML,
//      correct on its own.
//   2. paper-shaders' Dithering on top, only where WebGL actually exists. It
//      carries the motion and most of the character.
// Nothing load-bearing depends on layer 2. Layer 1 dims when layer 2 is present
// so the two do not double up.

// Strongest at the left and right edges, gone across the middle third. A second
// vertical pass keeps it from ending abruptly at the section's top and bottom.
const DITHER_MASK =
  "linear-gradient(to right, #000 0%, rgba(0,0,0,0.35) 24%, transparent 40%, transparent 60%, rgba(0,0,0,0.35) 76%, #000 100%), " +
  "linear-gradient(to bottom, transparent 0%, #000 18%, #000 82%, transparent 100%)";

const DITHER_MASK_STYLE = {
  maskImage: DITHER_MASK,
  WebkitMaskImage: DITHER_MASK,
  maskComposite: "intersect",
  WebkitMaskComposite: "source-in",
} as const;

function Backdrop() {
  const shader = useShaderGround();
  const still =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  return (
    <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
      {/* Layer 1: the permanent floor, on the mark's own 7px pitch. */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: "radial-gradient(rgba(230,63,44,0.55) 1.1px, transparent 1.1px)",
          backgroundSize: "7px 7px",
          opacity: shader ? 0.3 : 0.55,
          ...DITHER_MASK_STYLE,
        }}
      />

      {/* Layer 2: the shader, where WebGL exists. */}
      {shader ? (
        <div className="absolute inset-0" style={DITHER_MASK_STYLE}>
          <Dithering
            width="100%"
            height="100%"
            /* Literal hex: the shader parses colours itself, and this one is the
               brand accent, which does not invert with the page. Transparent
               back so it reads as ink on the ground rather than a glow. */
            colorBack="#00000000"
            colorFront="#e63f2c"
            shape="wave"
            type="4x4"
            size={2}
            speed={still ? 0 : 0.16}
            style={{ opacity: 0.62 }}
          />
        </div>
      ) : null}
    </div>
  );
}

// ── the open-source backdrop ───────────────────────────────────────────────

// Same library as the CLI band, different shape and mask. "warp" swirls where
// "wave" runs in bands, and the mask is radial rather than edge-to-edge: the
// pattern lives around the outside and clears through the middle, so the
// headline sits on paper rather than on a texture.
// No mask. The pattern runs the full band, edge to edge, and the type is made
// readable by a white glow layered OVER it (see OssGlow). Masking a hole in the
// pattern instead leaves an obvious rectangle, which is what a hard white band
// looked like and why it read as two blocks rather than one.
const OSS_GLOW =
  "radial-gradient(ellipse 54% 48% at 50% 50%, rgba(255,255,255,0.98) 0%, " +
  "rgba(255,255,255,0.94) 38%, rgba(255,255,255,0.72) 60%, rgba(255,255,255,0) 82%)";

function OssBackdrop() {
  const shader = useShaderGround();
  const still =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  return (
    <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: "radial-gradient(rgba(230,63,44,0.5) 1.1px, transparent 1.1px)",
          backgroundSize: "7px 7px",
          opacity: shader ? 0.3 : 0.5,
        }}
      />
      {shader ? (
        <div className="absolute inset-0">
          <Dithering
            width="100%"
            height="100%"
            colorBack="#00000000"
            colorFront="#e63f2c"
            shape="warp"
            type="4x4"
            size={2.5}
            speed={still ? 0 : 0.5}
            style={{ opacity: 0.55 }}
          />
        </div>
      ) : null}
    </div>
  );
}

// ── the night switch ───────────────────────────────────────────────────────

// The whole page goes dark while this section holds the middle of the viewport,
// and comes back when you scroll above it OR past it. The observer gives both
// ends for free: intersecting is the only state that is dark.
//
// The inset rootMargin is what makes it feel deliberate rather than twitchy: it
// fires when the section actually occupies the screen, not when its first pixel
// appears. The attribute lands on <html> so <body> can read the palette too.
function useNight<T extends HTMLElement>(ref: React.RefObject<T | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window)) return;

    const io = new IntersectionObserver(
      ([entry]) => {
        document.documentElement.toggleAttribute("data-night", entry.isIntersecting);
      },
      { rootMargin: "-38% 0px -38% 0px" }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      // Never leave the page dark on unmount.
      document.documentElement.removeAttribute("data-night");
    };
  }, [ref]);
}

function McpCard({ t }: { t: Messages }) {
  const shader = useShaderGround();
  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-[12px] bg-white">
      {/* The art panel.
       *
       * The ground is a layered radial mesh rather than one gradient: five warm
       * lobes at different sizes, which is what stops it reading as a flat
       * ramp. A grain overlay sits on top so it has paper in it.
       *
       * TODO: @paper-design/shaders-react was the intent here and it could not
       * be installed (no network in this environment). Swapping its MeshGradient
       * in means replacing THIS div's background only; the tiles, lines and mark
       * above it do not move. Keep this static mesh as the fallback, because a
       * WebGL shader needs one for reduced-motion and for no-WebGL anyway. */}
      <div className="relative h-[268px] overflow-hidden">
        {/* Two grounds, in this order on purpose.
         *
         * The CSS mesh underneath is the fallback: paper-shaders needs WebGL, and
         * a card whose whole ground is a canvas has no ground at all when the
         * context is refused (old hardware, blocked GPU, some VMs).
         *
         * The shader sits on top and covers it when it works. Its own grain
         * (grainOverlay) replaces the SVG turbulence layer that was here. */}
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(58% 62% at 18% 22%, #ffe3cb 0%, rgba(255,227,203,0) 68%)," +
              "radial-gradient(52% 58% at 84% 18%, #f3cfa8 0%, rgba(243,207,168,0) 66%)," +
              "radial-gradient(64% 66% at 78% 86%, #e79a61 0%, rgba(231,154,97,0) 70%)," +
              "radial-gradient(56% 60% at 14% 88%, #eeb182 0%, rgba(238,177,130,0) 68%)," +
              "linear-gradient(150deg, #fdeee1 0%, #eab98d 100%)",
          }}
        />
        {shader ? (
          <MeshGradient
            className="absolute inset-0 size-full"
            colors={["#fbe0c8", "#f5c49a", "#e79a61", "#fff4e9", "#e0803f"]}
            distortion={0.85}
            swirl={0.6}
            grainMixer={0.16}
            grainOverlay={0.13}
            speed={0.12}
          />
        ) : null}

        {/* Traces. Two passes: a wide soft one under a crisp one, which is what
            keeps a 1px line from disappearing against the mesh.

            preserveAspectRatio="none" stretches the box to the panel, which is
            fine because every run is orthogonal; non-scaling-stroke then keeps
            the weight even after that stretch. */}
        <svg
          viewBox="0 0 560 268"
          preserveAspectRatio="none"
          aria-hidden
          className="absolute inset-0 size-full"
        >
          {TRACES.map((d) => (
            <g key={d}>
              <path
                d={d}
                fill="none"
                stroke="rgba(255,255,255,0.55)"
                strokeWidth="3"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={d}
                fill="none"
                stroke="rgba(150,100,60,0.20)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
        </svg>

        {/* Pads on the traces. Divs rather than SVG rects so they stay square
            when the panel stretches. */}
        {PADS.map((pd) => (
          <span
            key={`${pd.left}-${pd.top}`}
            style={{ left: pd.left, top: pd.top }}
            aria-hidden
            className={cn(
              "absolute size-[9px] -translate-x-1/2 -translate-y-1/2 rounded-[2px]",
              "border border-[#ffffff]/50 shadow-[0_1px_3px_rgba(90,55,25,0.14)]",
              pd.c
            )}
          />
        ))}

        {MCP_CLIENTS.map((c) => (
          <LogoTile key={c.name} c={c} />
        ))}

        <span className="absolute left-[47%] top-[46%] grid size-[62px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-[#ffffff] text-brand shadow-[0_10px_30px_-8px_rgba(120,60,35,0.42)]">
          <Mark size={30} />
        </span>

      </div>

      {/* The sticker wordmark, straddling the panel's bottom edge as the
          reference does. It is a SIBLING of the panel, not a child: the panel
          needs overflow-hidden to clip the mesh and the tiles, and that would
          clip the lower half of these letters too.

          paint-order puts the white stroke behind the fill; without it the
          stroke eats the letterforms from the outside in. */}
      <div className="pointer-events-none absolute left-1/2 top-[268px] z-10 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2">
          <span
            className="font-sans text-[34px] font-semibold leading-none tracking-[-0.03em] text-[#0a0a0a]"
            style={{ paintOrder: "stroke fill", WebkitTextStroke: "9px #ffffff" }}
          >
            {BRAND}
          </span>
          <span className="grid size-7 place-items-center rounded-[8px] bg-[#ffffff] text-brand shadow-[0_1px_3px_rgba(0,0,0,0.10)]">
            <Mark size={17} />
          </span>
          <span
            className="font-sans text-[34px] font-semibold leading-none tracking-[-0.03em] text-[#0a0a0a]"
            style={{ paintOrder: "stroke fill", WebkitTextStroke: "9px #ffffff" }}
          >
            MCP
          </span>
      </div>

      <div className="flex flex-1 flex-col px-6 pb-6 pt-8">
        <div className="flex items-center gap-2.5">
          <span className="text-[15px] font-medium text-ink">MCP</span>
          {/* Not built yet, and labelled rather than implied. See
              docs/HANDOFF-panel.md §8. Delete the pill when it ships. */}
          <span className="rounded-full border border-line px-2 py-0.5 text-[10.5px] uppercase tracking-[0.1em] text-ink-3">
            {t.interfaces.mcp.soon}
          </span>
        </div>
        <p className="mt-2 max-w-[42ch] text-[14px] leading-[1.55] text-ink-2">
          {fill(t.interfaces.mcp.p, { brand: BRAND })}
        </p>
        <a className={cn(BTN, BTN_FILL, "mt-5 self-start")} href="/llms.txt">
          {t.interfaces.mcp.cta} <ArrowRight size={15} strokeWidth={2} />
        </a>
      </div>
    </div>
  );
}

// ── the command line ───────────────────────────────────────────────────────

// ── works with ─────────────────────────────────────────────────────────────

// Each brand's own lockup, in public/logos/brand. Supplied by hand rather than
// fetched: logo.dev got three of ten wrong (Microsoft's four-square for VS Code,
// Cognition's Devin for Windsurf, a white-on-white Cline), so these are the
// marks the brands actually publish.
//
// Every file is trimmed to its own ink and knocked free of its white plate, so a
// row of different aspect ratios still sits on one optical line. `h` is a
// per-mark height in px: a wordmark that runs 7:1 has to be shorter than one
// that runs 4:1 or it reads as louder than its neighbours.
const TOOLS: { name: string; file: string; h: number; label?: string }[] = [
  { name: "Claude Code", file: "claude", h: 26 },
  // Codex ships an icon with no wordmark, so the name is set beside it in Geist.
  { name: "Codex", file: "codex", h: 26, label: "Codex" },
  { name: "Cursor", file: "cursor", h: 22 },
  { name: "opencode", file: "opencode", h: 18 },
  { name: "Conductor", file: "conductor", h: 15 },
  { name: "Cline", file: "cline", h: 24 },
  { name: "Windsurf", file: "windsurf", h: 20 },
];

// ── onboard your agent ─────────────────────────────────────────────────────

// The hero's single CTA. It copies a prompt rather than navigating, because the
// first thing a person does with Bay is hand it to the thing writing their code.
//
// The three marks are the clients the prompt is written for. Square and only
// slightly rounded: the reference stacks circles, but circular avatars read as
// people, and these are tools.
const ONBOARD_AGENTS = ["claude", "openai", "cursor"];


function OnboardAgent({ t }: { t: Messages }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2200);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(onboardPrompt()).then(() => setCopied(true)).catch(() => {});
      }}
      aria-label={t.onboard.aria}
      className="group inline-flex h-12 items-center gap-3 rounded-[6px] border border-line bg-white pl-2.5 pr-2 transition-colors hover:bg-tile"
    >
      <span className="flex items-center">
        {ONBOARD_AGENTS.map((a, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={a}
            src={`/logos/${a}.png`}
            alt=""
            width={24}
            height={24}
            className={cn(
              "size-6 rounded-[4px] border border-line bg-[#ffffff] object-contain p-[3px]",
              i > 0 && "-ml-2"
            )}
          />
        ))}
      </span>
      <span className="text-[15px] font-medium text-ink">
        {copied ? t.onboard.copied : t.onboard.label}
      </span>
      <span
        className={cn(
          "grid size-8 place-items-center rounded-[4px] transition-colors",
          copied ? "text-live" : "text-ink-3 group-hover:text-ink"
        )}
      >
        {copied ? <Check size={16} strokeWidth={2.4} /> : <Copy size={15} strokeWidth={2} />}
      </span>
    </button>
  );
}

// ── reveal ─────────────────────────────────────────────────────────────────

// The section is armed here rather than in the stylesheet. Hiding it in CSS would
// mean a page that stays blank whenever this never runs, and that includes a
// failed hydration and every crawler. Arming in a layout effect happens before
// the first paint, so nothing flashes.
function useRise() {
  useLayoutEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(".bay .rise"));
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced || !("IntersectionObserver" in window)) return;

    els.forEach((el) => el.classList.add("armed"));

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.05 }
    );
    els.forEach((el) => io.observe(el));

    // Last resort. If the observer has not fired after a couple of seconds, the
    // reveal is no longer worth the risk of hiding real copy.
    const failsafe = setTimeout(() => els.forEach((el) => el.classList.add("in")), 2500);

    return () => {
      io.disconnect();
      clearTimeout(failsafe);
    };
  }, []);
}

// Arriving from the navbar on another route, which hands the target over as
// ?to=<id> because there is nothing to scroll to until this page exists.
// window.location rather than useSearchParams: that hook forces the whole page
// under a Suspense boundary for the sake of one query string.
function useScrollTarget() {
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("to");
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    // A frame later: the reveal arms in a layout effect, and measuring before it
    // settles reads the pre-animation position.
    requestAnimationFrame(() => {
      window.scrollTo({
        top: el.getBoundingClientRect().top + window.scrollY - NAV_H - 16,
        behavior: "smooth",
      });
      // Drop the parameter so a refresh does not jump again.
      window.history.replaceState(null, "", window.location.pathname);
    });
  }, []);
}

// ── the page ───────────────────────────────────────────────────────────────

export default function Landing({ t, locale }: { t: Messages; locale: Locale }) {
  const nightRef = useRef<HTMLElement | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  useRise();
  useNight(nightRef);
  useScrollTarget();

  // A photograph of the gate, square and unrounded, in place of the slash chip.
  // Deliberately NOT <Mark/>: docs/BRAND.md still describes the two leaning bars,
  // so this is a experiment on the lockup and the two disagree until one wins.
  const brand = (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo-bay.svg"
        alt=""
        width={30}
        height={30}
        className="size-[30px] shrink-0"
      />
      <span className="whitespace-nowrap text-[20px] font-medium tracking-[-0.03em]">{BRAND}</span>
    </>
  );

  return (
    <div className="bay bg-ground font-sans text-[16px] leading-[1.55] tracking-[-0.008em] text-ink antialiased">
      <SiteNav t={t} locale={locale} />

      {/* Everything between the nav and the footer, named. The landmark is for
          two readers at once: a screen reader gets a "skip to content" target,
          and an agent extracting the page gets a boundary it does not have to
          guess at. Without it the h1 sits in a bare <header> beside the nav's
          own markup, and a reader looking for the main content of the document
          has nothing to look inside. */}
      <main id="content">

      {/* ── hero ─────────────────────────────────────────────────────── */}

      {/* Roughly 380px of content and then air. Both references leave more than
          half the fold empty; that is the whole trick.

          A <section> and not a <header>, which it was. <header> is the tag for a
          masthead, and a reader that strips boilerplate — every extractor does,
          and the ones grading this page for agent-readability do — throws away
          <header>, <nav> and <footer> before it looks at anything. That took the
          h1 and its paragraph with it: the page measured ~490 characters lighter
          than it is and read as having no h1 at all. The heading is the start of
          the document, not furniture around it. */}
      <section className="pb-[clamp(40px,5vw,60px)] pt-[clamp(68px,8vw,108px)]">
        <div className={WRAP}>
          <h1 className="m-0 font-sans text-balance text-[clamp(30px,3.1vw,40px)] font-normal leading-[1.16] tracking-[-0.022em]">
            {t.hero.h1}
          </h1>
          <p className={cn(BODY, "mt-[18px]")}>
            {fill(t.hero.p, { brand: BRAND })}
          </p>
          <div className="mt-8">
            <OnboardAgent t={t} />
          </div>
        </div>
      </section>

      {/* ── the picture ──────────────────────────────────────────────── */}

      <section>
        <div className={WRAP}>
          <div className="overflow-hidden rounded-[8px] bg-tile leading-[0]">
            {/* The clip is decoration, not information: the page reads the same
                without it, so it carries no caption and is hidden from assistive
                tech. The poster is a real frame of the video, so first paint and
                first playable frame are the same picture.

                muted + playsInline are what make autoplay legal on iOS and in
                Chrome. preload="none" keeps the clip off the critical path.

                Cropped to 2:1 rather than its native 16:9: at this width 16:9 is
                630px tall and pushes the next section off the fold. */}
            <video
              className="block aspect-[2/1] w-full bg-tile object-cover motion-reduce:hidden"
              poster="/hero-bay-poster.jpg"
              autoPlay
              muted
              loop
              playsInline
              preload="none"
              aria-hidden
              tabIndex={-1}
            >
              {/* H.264 only, on purpose. VP9 came out LARGER than x264 on this
                  clip (fog and water sparkle are high-frequency, which VP9 handles
                  badly in one pass), and the CRF where it finally won on bytes
                  started banding that big smooth sky. 1.5 MB. */}
              <source src="/hero-bay.mp4" type="video/mp4" />
            </video>
            {/* Where the system asks for less motion, the poster stands in and
                nothing plays. */}
            <div
              aria-hidden
              className="hidden aspect-[2/1] w-full bg-tile bg-[url('/hero-bay-poster.jpg')] bg-cover bg-center motion-reduce:block"
            />
          </div>
        </div>
      </section>

      {/* ── what it is ───────────────────────────────────────────────── */}

      <section className="pt-[clamp(72px,8.5vw,120px)] pb-[clamp(44px,5vw,74px)]">
        <div
          className={cn(
            WRAP,
            "rise grid items-start gap-[clamp(32px,6vw,96px)] min-[900px]:grid-cols-[0.82fr_1.18fr]"
          )}
        >
          {/* No manual line break: where it wants to fall depends on the
              language, and text-balance already puts it in a sensible place. */}
          <h2 className={cn(H2, "text-balance")}>{t.intro.h2}</h2>
          <div>
            <p className={BODY}>
              {t.intro.p}
            </p>
            <div className="mt-6 flex flex-wrap gap-[26px]">
              <button type="button" className={ARROW} onClick={() => setPromptOpen(true)}>
                {t.intro.link}{" "}
                <ArrowRight size={15} strokeWidth={2} className={ARROW_ICON} />
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ── works with ───────────────────────────────────────────────── */}

      <section>
        <div className={cn(WRAP, "rise")}>
          <p className="text-center text-[15px] text-ink-2">
            {t.worksWith.line}
          </p>
          <div className="mt-7 grid grid-cols-2 gap-3 min-[560px]:grid-cols-4 min-[900px]:grid-cols-7">
            {TOOLS.map((t) => (
              <div
                key={t.name}
                title={t.name}
                className="group/tile flex h-[84px] items-center justify-center gap-2 rounded-[8px] bg-tile px-4"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/logos/brand/${t.file}.png`}
                  alt={t.label ? "" : t.name}
                  style={{ height: t.h }}
                  className={cn(
                    "w-auto max-w-full object-contain",
                    "grayscale brightness-[0.35] transition-[filter,opacity] duration-200",
                    "group-hover/tile:grayscale-0 group-hover/tile:brightness-100"
                  )}
                />
                {t.label ? (
                  <span className="text-[19px] font-medium tracking-[-0.02em] text-ink">
                    {t.label}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── features ─────────────────────────────────────────────────── */}

      {/* Six blocks, not eight rows: the subdomain, its padlock and an attached
          domain are one idea (an address), and the database and file storage are
          one idea (data). Nothing from the list is dropped.

          Every mock is drawn from the real product. `bay deploy`, the three
          visibility states, DATABASE_URL injection and `bay diagnose` all exist.
          MCP does not, so it is not claimed here at all. */}

      <section className="pb-[clamp(72px,8.5vw,120px)] pt-[clamp(34px,4vw,56px)]" id="features">
        <div className={WRAP}>
          <div className="rise max-w-[36ch]">
            <h2 className={cn(H2, "mt-[18px]")}>{t.features.h2}</h2>
          </div>

          {FEATURES.map((f, i) => {
            const flip = i % 2 === 1;
            return (
              <div
                key={f.id}
                id={f.id}
                className={cn(
                  "rise mt-5 grid items-stretch gap-[clamp(28px,4vw,64px)] overflow-hidden rounded-[16px]",
                  "bg-tile p-6 min-[900px]:min-h-[min(78vh,660px)] min-[900px]:rounded-[22px]",
                  "min-[900px]:p-[clamp(30px,4vw,60px)]",
                  flip
                    ? "min-[900px]:grid-cols-[1.25fr_1fr]"
                    : "min-[900px]:grid-cols-[1fr_1.25fr]"
                )}
              >
                <div
                  className={cn(
                    "flex flex-col justify-center py-[clamp(4px,2vw,26px)]",
                    flip && "min-[900px]:order-2"
                  )}
                >
                  <h3 className="m-0 font-sans text-balance text-[clamp(21px,2.15vw,28px)] font-normal leading-[1.18] tracking-[-0.024em]">
                    {t.features[f.id].h}
                  </h3>
                  <p className="m-0 max-w-[30ch] text-pretty text-[clamp(21px,2.15vw,28px)] font-normal leading-[1.18] tracking-[-0.024em] text-ink-2">
                    {fill(t.features[f.id].p, { brand: BRAND })}
                  </p>
                  <button
                    type="button"
                    className={cn(BTN, BTN_FILL, "mt-7 self-start")}
                    onClick={() => setPromptOpen(true)}
                  >
                    {t.features.cta} <ArrowRight size={15} strokeWidth={2} />
                  </button>
                </div>

                <div
                  className={cn(
                    "flex h-full min-h-[240px] items-end overflow-hidden rounded-[16px] pl-5 pt-5",
                    "min-[900px]:min-h-[400px] min-[900px]:pt-[34px]",
                    TINT[f.tint],
                    flip ? "min-[900px]:px-[34px]" : "min-[900px]:pl-[34px] min-[900px]:pr-0"
                  )}
                >
                  {f.mock(!flip)}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── how you talk to it ───────────────────────────────────────── */}

      {/* Deliberately not a feature block. Full-bleed dark, which is the only
          place on the page that inverts: the CLI and MCP are the machine surface,
          and a terminal belongs on dark. The design system is light-only by
          decision (dark mode was dropped, not carried) so this is an accent
          surface, not a theme. */}

      <section ref={nightRef} id="interfaces" className="relative overflow-hidden py-[clamp(72px,8.5vw,120px)]">
        <Backdrop />
        <div className={cn(WRAP, "rise relative z-10")}>
          <h2 className={H2}>{t.interfaces.h2}</h2>
          {/* Side by side, and both light so they read as a pair against the
              band. Each is modelled on its own reference: the CLI card on the
              shadcn docs command block, the MCP card on Refero's. */}
          <div className="mt-[clamp(22px,2.6vw,34px)] grid items-stretch gap-5 min-[900px]:grid-cols-[1.32fr_1fr]">
            <CliCard t={t} />
            <McpCard t={t} />
          </div>
        </div>
      </section>

      {/* ── templates ────────────────────────────────────────────────── */}

      {/* Placed after the CLI and MCP band on purpose: the page has just said
          what the agent surface is, so this is the first concrete thing to point
          an agent AT. Cards read from lib/templates.ts, the same record the
          template pages and agent.md render, so this teaser cannot drift from
          what the instructions actually do. */}

      <section className={SECTION} id="templates">
        <div className={cn(WRAP, "rise")}>
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div className="max-w-[36ch]">
              <h2 className={H2}>{t.templatesSection.h2}</h2>
            </div>
            <a className={ARROW} href={localePath(locale, "/templates")}>
              {t.templatesSection.all} <ArrowRight size={15} strokeWidth={2} className={ARROW_ICON} />
            </a>
          </div>

          <div className="mt-[clamp(28px,3.4vw,44px)] grid gap-4 min-[760px]:grid-cols-3">
            {TEMPLATES.map((tpl) => (
              <a
                key={tpl.slug}
                href={localePath(locale, `/templates/${tpl.slug}`)}
                className="group/card flex flex-col overflow-hidden rounded-[12px] bg-tile p-6 pb-0"
              >
                <span className="flex items-center gap-2.5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/logos/brand/${tpl.logo}.png`}
                    alt=""
                    className="h-[18px] w-auto shrink-0 object-contain"
                  />
                  <span className="text-[17px] font-medium tracking-[-0.02em]">{tpl.name}</span>
                </span>

                {/* Heading and blurb butt together as one block, two colours, the
                    same treatment as the feature panels above. */}
                <span className="mt-1.5 text-[17px] leading-[1.45] tracking-[-0.015em] text-ink-2">
                  {fill(t.templates[tpl.slug].blurb, { brand: BRAND, cli: CLI })}
                </span>

                <span className="mt-4 inline-flex items-center gap-2 text-[15px] text-brand-ink">
                  {t.templatesSection.cardCta}
                  <ArrowRight
                    size={15}
                    strokeWidth={2}
                    className="transition-transform group-hover/card:translate-x-[3px]"
                  />
                </span>

                {/* Bottom, and flush with the card's edge so it reads as running
                    on past it rather than as a picture in a box. object-top
                    because these are interfaces and the top is the real content. */}
                <span className="mt-6 block h-[210px] overflow-hidden rounded-t-[8px] bg-white">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={tpl.shot}
                    alt={fill(t.templatesSection.shotAlt, { name: tpl.name })}
                    width={720}
                    height={450}
                    className="size-full object-cover object-top transition-transform duration-500 group-hover/card:scale-[1.03]"
                  />
                </span>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* ── open source ──────────────────────────────────────────────── */}

      {/* Full bleed, centred, and almost no words. Both claims are made by the
          things on the page rather than by sentences about them: the star pill IS
          the "we are open source" claim, and the button IS the offer. */}

      <section
        className="relative overflow-hidden border-t border-line py-[clamp(80px,10vw,140px)]"
        id="open-source"
      >
        <OssBackdrop />

        {/* The glow: a soft white pool over the pattern, so the type has paper
            under it without the pattern stopping. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[5]"
          style={{ background: OSS_GLOW }}
        />

        <div className="relative z-10 py-[clamp(24px,3vw,44px)]">
          <div className={cn(WRAP, "rise text-center")}>
            <Stars
              className={cn(BTN, "gap-2 border-line bg-white text-ink hover:bg-tile")}
            />

            <h2 className={cn(H2, "mx-auto mt-6 max-w-[24ch]")}>{t.oss.h2}</h2>
            <p className="mx-auto mt-4 max-w-[42ch] text-[17px] leading-[1.6] text-ink-2">
              {t.oss.p}
            </p>

            {/* Not a link to our three templates: the year is for any public
                repo, and a list is only ever a list of things we happened to
                write down. The prompt asks WHICH project, so it works for
                whatever they actually wanted. */}
            <div className="mt-7 flex justify-center">
              <CopyPrompt
                prompt={selfhostPrompt()}
                label={t.oss.cta}
                copiedLabel={t.copyPrompt.copied}
                logos={["claude", "openai", "cursor"]}
              />
            </div>

          </div>
        </div>
      </section>

      {/* ── closing ──────────────────────────────────────────────────── */}

      <section className="border-t border-line py-[clamp(76px,9vw,130px)]">
        <div className={cn(WRAP, "rise text-center")}>
          <h2 className={cn(H2, "mx-auto")}>{t.closing.h2}</h2>
          {/* The same control as the hero, and the only one here. The page opens
              by asking you to hand a prompt to your agent; closing on a
              different ask would be closing on a different product. */}
          <div className="mt-[26px] flex justify-center">
            <OnboardAgent t={t} />
          </div>
        </div>
      </section>

      </main>

      {/* ── footer ───────────────────────────────────────────────────── */}

      <footer className="border-t border-line pb-10 pt-12">
        <div className={cn(WRAP, "flex flex-wrap items-start gap-x-14 gap-y-8")}>
          <div className="min-w-[200px]">
            <a className="flex items-center gap-[9px]" href={localePath(locale, "/")}>
              {brand}
            </a>
            <p className="mt-3.5 max-w-[24ch] text-[14px] text-ink-3">{t.footer.tagline}</p>
          </div>
          <div className="flex-1" />
          {[
            {
              head: t.footer.product,
              links: [
                [t.footer.whatYouGet, "#features"],
                [t.footer.pricing, "/pricing"],
              ],
            },
            {
              head: t.footer.build,
              links: [
                [t.footer.docs, DOCS_URL],
                [t.footer.agentManual, "/llms.txt"],
                [t.footer.shipAnApp, `${APP_URL}/new`],
                [t.footer.signIn, APP_URL],
              ],
            },
            {
              head: t.footer.company,
              // The pages, not the mailto. /about, /contact and /privacy are
              // what a person checks before they trust a platform with their
              // code, and what a model checks before it will recommend one —
              // and neither can check a page nothing links to. The contact
              // page carries the address this used to open directly.
              links: [
                [t.footer.about, "/about"],
                [t.footer.contact, "/contact"],
                [t.footer.privacy, "/privacy"],
                [t.footer.github, GITHUB_URL],
              ],
            },
          ].map((col) => (
            <div key={col.head} className="flex min-w-[116px] flex-col gap-[10px]">
              <span className="mb-1 text-[14.5px] text-ink-3">{col.head}</span>
              {col.links.map(([label, href]) => {
                // Third-party links open in a new tab. The control plane does
                // NOT: signing in is a flow, and a flow that opens behind you is
                // a flow you lose. In-page anchors and mailto: stay put too.
                const away = href.startsWith("http") && !href.startsWith(APP_URL);
                return (
                  <a
                    key={label}
                    href={localePath(locale, href)}
                    {...(away ? { target: "_blank", rel: "noreferrer" } : {})}
                    className="text-[14.5px] text-ink-2 hover:text-ink"
                  >
                    {label}
                  </a>
                );
              })}
            </div>
          ))}
          <div className="mt-10 flex w-full flex-wrap justify-between gap-4 border-t border-line pt-5 text-[13px] text-ink-3">
            <span>{fill(t.footer.rights, { year: new Date().getFullYear() })}</span>
            <LanguagePicker label={t.footer.languageAria} />
          </div>
        </div>
      </footer>

      <PromptDialog
        open={promptOpen}
        onOpenChange={setPromptOpen}
        prompt={onboardPrompt()}
        t={t}
      />
    </div>
  );
}
