/**
 * Metal, as a fill layer.
 *
 * These are the actual plates authored in Paper, exported at 2x and served from
 * /public/metal. Nothing is generated at runtime: the finishes were tuned by
 * eye against a real steel photograph, and re-deriving them live from
 * `feTurbulence` meant every instance paid for a filter pass to reproduce a
 * picture we already had. Six files, 72 KB total, cached like any other asset.
 *
 * `cover` rather than a stretched fit, so the grain keeps its real proportions
 * at any box size — a wide button shows a horizontal slice of the plate instead
 * of the whole thing squashed into 40px.
 *
 * `dim` exists because a plate that looks right on its own is not automatically
 * safe under a label. The bright end of the red plate reaches ~#F5806B, which is
 * 2.57:1 against white; the dark end of steel reaches ~#4B5154, which is 1.88:1
 * against ink. Both are invisible failures — the button looks fine in a
 * screenshot and is unreadable in the one corner where the grain peaks. The
 * factors below were derived from those worst points, not chosen by eye.
 */

export type Finish = "brushed" | "panoramic" | "satin";
export type Tone = "steel" | "red";

/**
 * The steel plate was mixed as a mid-grey structural surface, which sits darker
 * than it should for a small control. Multiplying lightens without touching the
 * ramp's shape, so the top-to-bottom falloff — and the shadow it puts under the
 * button — survives; a white blend would flatten that out.
 */
const LIFT: Record<Tone, number> = { steel: 1.2, red: 1 };

const SRC: Record<Finish, Record<Tone, string>> = {
  brushed: { steel: "/metal/brushed-steel.webp", red: "/metal/brushed-red.webp" },
  panoramic: { steel: "/metal/panoramic-steel.webp", red: "/metal/panoramic-red.webp" },
  satin: { steel: "/metal/satin-steel.webp", red: "/metal/satin-red.webp" },
};

export function Metal({
  finish = "brushed",
  tone = "steel",
  zoom = 1,
  className = "",
}: {
  finish?: Finish;
  tone?: Tone;
  /**
   * Horizontal magnification of the plate. The height always stays at 100%.
   *
   * That asymmetry is the point. The grain runs vertically, so stretching only
   * the width fattens the lines into visibility, while pinning the height keeps
   * the plate's full top-to-bottom ramp inside the box — which is what puts the
   * lit edge along the top and the shadow along the bottom. Scaling both axes
   * (what `cover` does) crops to a middle slice and throws that ramp away, so
   * the button goes flat exactly as it gains texture.
   */
  zoom?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 bg-center bg-no-repeat ${className}`}
      style={{
        backgroundImage: `url(${SRC[finish][tone]})`,
        filter: LIFT[tone] === 1 ? undefined : `brightness(${LIFT[tone]})`,
        backgroundSize: `${zoom * 100}% 100%`,
      }}
    />
  );
}
