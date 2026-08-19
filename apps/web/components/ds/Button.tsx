"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * A button is two surfaces that cross-fade: what it looks like at rest, and
 * what it looks like under the cursor. Either end can be white or flat red, so
 * "white until you point at it" and "red until you point at it" are the same
 * component with the ends swapped.
 *
 * Metal used to be a third and fourth surface: two `.webp` plates cross-fading
 * under the cursor, with a lit top edge to sell it as a pressable object. It is
 * gone, along with `Metal.tsx` and `public/metal/`. The panel design system this
 * product now follows draws flat surfaces with one accent, and the plates cost
 * every page that used a button two image fetches to draw one.
 *
 * The label colour has to travel with the surface — ink on white, white on red —
 * so it is part of the pair, not a separate decision. Same for the hairline
 * ring.
 *
 * Two hover mechanisms, and mixing them up is a silent failure. Classes on the
 * <button> itself use plain `hover:` — the button IS the group, and
 * `group-hover:` compiles to `.group:hover .x`, a descendant combinator that can
 * never match the group element. Only real child nodes, like the rolling label
 * copies below, use `group-hover:`.
 *
 * Class strings are written out per surface rather than composed, because
 * Tailwind scans source text — a template literal like `group-hover:${x}`
 * produces a class that is never generated.
 */

export type Surface = "white" | "solid";
type Size = "sm" | "md" | "lg";

const SIZE: Record<Size, string> = {
  sm: "h-8 px-3 text-sub rounded-lg",
  md: "h-10 px-4 text-val rounded-lg",
  lg: "h-12 px-6 text-body rounded-xl",
};

const GAP: Record<Size, string> = {
  sm: "gap-1.5",
  md: "gap-2",
  lg: "gap-2.5",
};

/**
 * The label rolls rather than fading.
 *
 * Two identical copies share one grid cell — the live one at rest, a duplicate
 * parked one line below. Hover slides the pair up: the original leaves through
 * the top, the duplicate arrives from underneath. Releasing runs it backwards,
 * so the original drops back in from above rather than reversing out of a
 * half-finished move. The duplicate is aria-hidden, otherwise every button
 * reads its own label twice.
 */
const ROLL = "transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none";

const REST_LABEL: Record<Surface, string> = {
  white: "text-ink",
  solid: "text-white",
};

const HOVER_LABEL: Record<Surface, string> = {
  white: "hover:text-ink",
  solid: "hover:text-white",
};

const REST_RING: Record<Surface, string> = {
  white: "ring-1 ring-inset ring-line",
  solid: "ring-1 ring-inset ring-red-deep",
};

const HOVER_RING: Record<Surface, string> = {
  white: "hover:ring-1 hover:ring-inset hover:ring-line",
  solid: "hover:ring-1 hover:ring-inset hover:ring-red-deep",
};

const REST_BG: Record<Surface, string> = {
  white: "bg-white",
  solid: "bg-red-btn shadow-cta",
};

const HOVER_BG: Record<Surface, string> = {
  white: "hover:bg-white",
  solid: "hover:bg-red-btn hover:shadow-cta",
};

export function Button({
  rest = "white",
  hover,
  size = "md",
  children,
  className = "",
  ...props
}: {
  /** Surface at rest. */
  rest?: Surface;
  /** Surface under the cursor. Defaults to no change. */
  hover?: Surface;
  size?: Size;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const to = hover ?? rest;

  return (
    <button
      {...props}
      className={[
        "group relative isolate inline-flex items-center justify-center overflow-hidden",
        "font-sans font-medium tracking-[-0.01em]",
        "transition-[color,box-shadow,background-color] duration-200",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red",
        "disabled:pointer-events-none disabled:opacity-40",
        SIZE[size],
        REST_BG[rest],
        rest !== to ? HOVER_BG[to] : "",
        REST_RING[rest],
        rest !== to ? HOVER_RING[to] : "",
        REST_LABEL[rest],
        rest !== to ? HOVER_LABEL[to] : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Invisible and in flow: this is what gives the button its width, since
          both moving copies are taken out of flow. */}
      <span
        aria-hidden="true"
        className={`invisible inline-flex items-center whitespace-nowrap ${GAP[size]}`}
      >
        {children}
      </span>

      <span
        className={`absolute inset-0 z-10 flex items-center justify-center whitespace-nowrap ${GAP[size]} ${ROLL} group-hover:-translate-y-full motion-reduce:group-hover:translate-y-0`}
      >
        {children}
      </span>
      <span
        aria-hidden="true"
        className={`absolute inset-0 z-10 flex translate-y-full items-center justify-center whitespace-nowrap ${GAP[size]} ${ROLL} group-hover:translate-y-0 motion-reduce:hidden`}
      >
        {children}
      </span>
    </button>
  );
}
