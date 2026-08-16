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
        ink: {
          DEFAULT: "#262626", // 15.13:1
          2: "rgba(38,38,38,0.72)", //  6.01:1
          3: "rgba(38,38,38,0.60)", //  4.62:1
          4: "rgba(38,38,38,0.40)", //  2.38:1 — icons and rules only
        },
        red: {
          DEFAULT: "#E63F2C", // brand. Marks, fills, metal. Never small text.
          btn: "#D6351F", // solid button ground
          ink: "#C9301B", // every word inside a tint
          deep: "#A32414", // bottom of the metal ramp
        },
        tint: {
          DEFAULT: "rgba(230,63,44,0.039)", // Paper's 3.9%
          hi: "rgba(230,63,44,0.075)", // hover
        },
        line: "#EDEDED",
        // The ground blocks sit on. Deliberately darker than `line`: the corner
        // wells are only as visible as this is different from the block, and at
        // #EDEDED (1.17:1 on white) the shape is technically present and
        // practically invisible.
        ground: "#E4E4E4",
        sunken: "#FBFBFB",
        tile: "#F9F9F9",
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
  plugins: [],
} satisfies Config;
