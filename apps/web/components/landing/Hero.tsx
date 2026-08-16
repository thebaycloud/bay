"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Dithering } from "@paper-design/shaders-react";
import { Button } from "@/components/ds/Button";
import { COL } from "@/components/landing/Bridge";

/**
 * The hero.
 *
 * The hero carries its own shader inside the column; the fog in the margins is
 * a separate field belonging to the whole document. Two WebGL contexts, so both
 * are capped to the same pixel budget.
 *
 * The call to action is the product rather than a gate in front of it: there is
 * no email field and no signup, you copy a prompt and paste it into whatever
 * agent you already use. That is worth protecting — every competitor's landing
 * page puts a form here.
 */

/**
 * Hero palette. Flip PALETTE to switch the shader and its no-WebGL ground
 * together — they have to move as a pair or the fallback shows a different
 * design from the shader.
 */
const PALETTE: "red" | "grey" | "blue" = "red";

const PALETTES = {
  /* Lighter than the brand #E63F2C on purpose: at hero size the brand value is
     a wall of colour, and it would also swallow the red CTA sitting on top. */
  red: {
    colorBack: "#eda091",
    ground: "radial-gradient(75% 60% at 22% 18%, #F5BCB1 0%, #EDA091 55%, #E08876 100%)",
  },
  grey: {
    colorBack: "#9aa1a8",
    ground: "radial-gradient(75% 60% at 22% 18%, #B4BAC0 0%, #9AA1A8 55%, #848B93 100%)",
  },
  blue: {
    colorBack: "#83adec",
    ground: "radial-gradient(75% 60% at 22% 18%, #9CBFF0 0%, #83ADEC 55%, #6E9CE4 100%)",
  },
} as const;

const SHADER = PALETTES[PALETTE];

const PROMPT = `Ship this project to production with Supersonic.
Run \`npx -y supersonic@latest ship\`, provision whatever
the repo needs, and give me the live URL when it's up.`;

function PromptBox() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(PROMPT);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the text is on screen and selectable anyway */
    }
  }

  return (
    <div className="w-full max-w-[620px] overflow-hidden rounded-xl bg-white shadow-[0_1px_2px_rgba(38,38,38,0.06),0_12px_40px_-8px_rgba(38,38,38,0.18)] ring-1 ring-black/[0.06]">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-3">
          Paste into your agent
        </span>
        <button
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 font-mono text-[11px] text-ink-2 transition-colors hover:bg-ink/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-red"
        >
          {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={2} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-4 text-left font-mono text-[13px] leading-[22px] text-ink">
        {PROMPT}
      </pre>
    </div>
  );
}

export function Hero() {
  return (
    <section className="w-full">
      <div
        className="relative isolate mx-auto flex min-h-[84vh] flex-col items-center justify-center overflow-hidden px-6"
        style={{ maxWidth: COL }}
      >
      {/* No-WebGL ground, so the hero is a considered blue rather than blank. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-30"
        style={{
          background: SHADER.ground,
        }}
      />

      {/* `data-paper-shader` is not decorative. The library injects a stylesheet
          scoped to `:where([data-paper-shader]) canvas` that stretches the canvas
          to its container, but shaders-react@0.0.80 never puts the attribute on
          the wrapper it renders — without it the canvas sits at its intrinsic
          300x150 and the shader is invisible. */}
      <Dithering
        data-paper-shader=""
        className="absolute inset-0 -z-20"
        width="100%"
        height="100%"
        /* Second shader on the page, so the same budget caps as the backdrop
           apply. The library otherwise supersamples into ~8.3MP each. */
        minPixelRatio={1}
        maxPixelCount={2_400_000}
        colorBack={SHADER.colorBack}
        colorFront="#ffffff"
        shape="wave"
        type="4x4"
        size={11}
        scale={1.2}
        speed={0.2}
        rotation={20}
        offsetX={0.44}
        offsetY={-0.06}
      />

      {/* White veil so dark type keeps a ground. ink-2 measures 2.62:1 on this
          blue, which is why the copy below runs at full ink instead. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(58% 48% at 50% 46%, rgba(255,255,255,0.72) 0%, rgba(255,255,255,0.42) 48%, rgba(255,255,255,0) 100%)",
        }}
      />
      <div className="flex w-full max-w-[760px] flex-col items-center gap-7 text-center">
        <span className="size-3.5 rounded-[3px] bg-white shadow-[0_2px_12px_rgba(0,0,0,0.22)]" />

        <h1 className="text-balance text-[clamp(34px,5.2vw,56px)] font-semibold leading-[1.28] tracking-[-0.04em] text-ink">
          <span className="box-decoration-clone bg-white px-4 py-1">
            Cloud for AI generated code
          </span>
          <br />
        </h1>

        {/* Back to ink-2: the copy sits on its own white plate now, so the
            blue ground no longer sets the contrast floor. */}
        <p className="max-w-[48ch] text-body leading-[1.9] text-ink-2 hidden">
          <span className="box-decoration-clone bg-white px-2 py-1">
            Your agent already wrote the app. Supersonic turns it into a real product at
            a real address — database, auth, files, all of it. You never open a dashboard.
          </span>
        </p>

        <PromptBox />

        <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
          <Button rest="red" hover="white" size="lg">
            Copy prompt for your agent
          </Button>
          <Button rest="white" hover="steel" size="lg">
            See a live app
          </Button>
        </div>

        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-3">
          <span className="box-decoration-clone bg-white px-2.5 py-1.5">
            No signup · Free for 3 apps
          </span>
        </p>
        </div>
      </div>
    </section>
  );
}
