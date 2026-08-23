import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      /* Bay's palette, from docs/HANDOFF-panel.md §4 (decided 18 Aug). Named
         here so the landing page and the panel cannot drift: change a value in
         one place and every utility that spends it follows.

         Green is NOT a second accent. `brand` is the accent; `live` is status. */
      colors: {
        /* Channel triplets so /<alpha-value> keeps working, and so the whole
           palette can be swapped at once when the page goes dark. Values live
           in app/home/home.css on :root and html[data-night].

           `white` is rebound on purpose: every raised surface on the page is
           bg-white, and in the dark pass they have to become raised DARK rather
           than stay white. The MCP art panel opts out with literal #ffffff,
           because it is a picture and pictures do not invert. */
        ground: "rgb(var(--c-ground) / <alpha-value>)",
        tile: "rgb(var(--c-tile) / <alpha-value>)",
        line: "rgb(var(--c-line) / <alpha-value>)",
        white: "rgb(var(--c-white) / <alpha-value>)",
        ink: {
          DEFAULT: "rgb(var(--c-ink) / <alpha-value>)",
          2: "rgb(var(--c-ink-2) / <alpha-value>)",
          3: "rgb(var(--c-ink-3) / <alpha-value>)",
        },
        /* The accent does not invert. It is the one fixed thing in both passes. */
        brand: { DEFAULT: "#e63f2c", deep: "#fc8779", ink: "#b32c1a" },
        live: "#16a34a",
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "-apple-system", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "SF Mono", "Menlo", "monospace"],
      },
      animation: {
        marquee: "marquee var(--duration) linear infinite",
        "marquee-vertical": "marquee-vertical var(--duration) linear infinite",
      },
      keyframes: {
        marquee: {
          from: { transform: "translateX(0)" },
          to: { transform: "translateX(calc(-100% - var(--gap)))" },
        },
        "marquee-vertical": {
          from: { transform: "translateY(0)" },
          to: { transform: "translateY(calc(-100% - var(--gap)))" },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
