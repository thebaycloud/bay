// Supersonic brand mark — "the slash".
//
// Geometry is documented in docs/BRAND.md. There are three drawings, not one
// drawing at three sizes: the master goes soft below 24px, and a knocked-out
// (light-on-dark) glyph needs extra weight because antialiasing eats it.
//
// KEEP IN SYNC with apps/web/components/Mark.tsx and the inline copy in
// services/proxy/src/inject.ts.

const PATHS = {
  // >= 24px, positive. Lean 5:12, cap 20, bar 5, gap 2.6.
  regular: [
    "M9.87 2 L14.87 2 L6.54 22 L1.54 22 Z",
    "M17.47 2 L22.47 2 L14.14 22 L9.14 22 Z",
  ],
  // < 24px, positive. Shallower lean, fatter bars, wider gap so it survives.
  compact: [
    "M8.17 1 L14.17 1 L6.83 23 L0.83 23 Z",
    "M17.17 1 L23.17 1 L15.83 23 L9.83 23 Z",
  ],
  // Light on dark, any size. ~13% more mass to compensate for irradiation.
  knockout: [
    "M7.4 1.5 L14.2 1.5 L7.2 22.5 L0.4 22.5 Z",
    "M16.8 1.5 L23.6 1.5 L16.6 22.5 L9.8 22.5 Z",
  ],
} as const;

export type MarkVariant = keyof typeof PATHS;

export function Mark({
  size = 24,
  onDark = false,
  variant,
  title,
  ...rest
}: {
  /** Rendered px size. Picks the drawing; it is not just a scale factor. */
  size?: number;
  /** True when the glyph sits on the accent chip or any dark field. */
  onDark?: boolean;
  /** Force a drawing. Leave unset — `size` and `onDark` pick correctly. */
  variant?: MarkVariant;
  title?: string;
} & React.SVGProps<SVGSVGElement>) {
  const v: MarkVariant =
    variant ?? (onDark ? "knockout" : size >= 24 ? "regular" : "compact");

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      shapeRendering="geometricPrecision"
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[v].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
