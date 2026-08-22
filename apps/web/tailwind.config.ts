import type { Config } from "tailwindcss";

/**
 * The token layer.
 *
 * Everything here comes from the Paper file the design was ported from, with
 * three values deliberately changed because the originals fail WCAG AA:
 *
 *   red.ink  #C9301B  — text on tint. The brand red measures 3.58:1 there.
 *   red.btn  #D6351F  — solid button ground. White on brand red is 4.11:1.
 *   ink.3    60%      — Paper ships 56%, which is 3.69:1 on white.
 *
 * The radius scale is NOT overridden: Tailwind v3 already ships
 * md=6px lg=8px xl=12px, which is exactly what the reference uses.
 */
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // One near-black at four opacities. This single decision is most of
        // why the reference reads calm rather than stark.
        /* Channel triplets, so `text-ink/60` works and the whole palette can be
           swapped at once. The four fixed opacities these used to be are gone:
           an alpha modifier expresses the same thing and does not need a name.
           Same values as apps/landing, deliberately. */
        ink: {
          DEFAULT: "rgb(var(--c-ink) / <alpha-value>)",
          2: "rgb(var(--c-ink-2) / <alpha-value>)",
          3: "rgb(var(--c-ink-3) / <alpha-value>)",
          4: "rgb(var(--c-ink-3) / <alpha-value>)",
        },
        red: {
          DEFAULT: "rgb(var(--c-red) / <alpha-value>)", // brand. Marks, fills, metal. Never small text.
          btn: "#D6351F", // solid button ground
          ink: "#C9301B", // every word inside a tint
          deep: "#A32414", // bottom of the metal ramp
        },
        tint: {
          DEFAULT: "rgba(230,63,44,0.039)", // Paper's 3.9%
          hi: "rgba(230,63,44,0.075)", // hover
        },
        line: "rgb(var(--c-line) / <alpha-value>)",

        // ---- the shadcn contract ----
        // Its components reference bg-background, border-input, ring-ring and so
        // on. These map those names onto the panel tokens defined in globals.css
        // under a --sh- prefix, so a component pulled from the registry is
        // already ours and needs no edit to fit. The prefix exists because our
        // own token names collide with three of shadcn's: --card, --accent and
        // --ring all mean something different here.
        background: "var(--sh-background)",
        foreground: "var(--sh-foreground)",
        border: "var(--sh-border)",
        input: "var(--sh-input)",
        ring: "var(--sh-ring)",
        primary: {
          DEFAULT: "var(--sh-primary)",
          foreground: "var(--sh-primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--sh-secondary)",
          foreground: "var(--sh-secondary-foreground)",
        },
        muted: {
          DEFAULT: "var(--sh-muted)",
          foreground: "var(--sh-muted-foreground)",
        },
        accent: {
          DEFAULT: "var(--sh-accent)",
          foreground: "var(--sh-accent-foreground)",
        },
        destructive: {
          DEFAULT: "var(--sh-destructive)",
          foreground: "var(--sh-destructive-foreground)",
        },
        popover: {
          DEFAULT: "var(--sh-popover)",
          foreground: "var(--sh-popover-foreground)",
        },
        // `card` here is a TAILWIND colour name, which is a different namespace
        // from the `--card` CSS variable above — no collision, and shadcn's
        // components write `bg-card` literally.
        card: {
          DEFAULT: "var(--sh-card)",
          foreground: "var(--sh-card-foreground)",
        },
        // The ground blocks sit on. Deliberately darker than `line`: the corner
        // wells are only as visible as this is different from the block, and at
        // #EDEDED (1.17:1 on white) the shape is technically present and
        // practically invisible.
        ground: "rgb(var(--c-ground) / <alpha-value>)",
        sunken: "#FBFBFB",
        // Points at the CSS variable rather than carrying a second value.
        // `bg-tile` was resolving to #F9F9F9 here while --tile was #F4F4F5 in
        // globals.css, so a filled input looked white and nobody could see why.
        tile: "rgb(var(--c-tile) / <alpha-value>)",
        // Wet steel at low tide — the metal ramp.
        steel: {
          50: "#C4CCD0",
          100: "#B4BBC0",
          200: "#A6ADB2",
          300: "#8F979D",
          DEFAULT: "#8B9399",
          600: "#798288",
          700: "#5A646A",
        },
      },
      borderRadius: {
        // 8/6/4, which is shadcn's own ramp and already the panel's.
        xl: "calc(var(--sh-radius) + 2px)",
        lg: "var(--sh-radius)",
        md: "calc(var(--sh-radius) - 2px)",
        sm: "calc(var(--sh-radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "SF Mono", "monospace"],
      },
      fontSize: {
        // Paper's scale. [size, { lineHeight, letterSpacing }]
        label: ["11px", { lineHeight: "16px", letterSpacing: "0.14em" }],
        micro: ["12px", { lineHeight: "16px" }],
        sub: ["13px", { lineHeight: "20px" }],
        val: ["14px", { lineHeight: "22px" }],
        body: ["16px", { lineHeight: "24px" }],
        section: ["20px", { lineHeight: "28px", letterSpacing: "-0.1px" }],
        title: ["28px", { lineHeight: "32px", letterSpacing: "-0.035em" }],
        display: ["44px", { lineHeight: "46px", letterSpacing: "-0.042em" }],
      },
      boxShadow: {
        // The five-layer ladder from the reference's Copy button, ported to red.
        // This is what makes a button read as an object rather than a rectangle.
        cta: [
          "inset 0 -6px 12px rgba(230,24,12,0.20)",
          "0 2px 4px rgba(230,63,44,0.12)",
          "0 1px 1px rgba(230,63,44,0.12)",
          "0 0.5px 0.5px rgba(230,63,44,0.16)",
          "0 0.25px 0.25px rgba(230,63,44,0.20)",
        ].join(", "),
        plate: [
          "inset 0 1px 0 rgba(255,255,255,0.45)",
          "inset 0 -1px 0 rgba(13,19,22,0.30)",
        ].join(", "),
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
