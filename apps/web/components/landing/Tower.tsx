import { COL } from "./Bridge";

/**
 * A Golden Gate tower, lying on its side, used as a section divider.
 *
 * Drawn already horizontal rather than rotated with a transform, so the
 * coordinates are the ones you read on screen. The tower's long axis runs
 * left to right and its width runs top to bottom; the narrow end (the top of
 * the real tower) is on the left.
 *
 * What makes it the Golden Gate rather than a ladder:
 *
 *   setbacks   the legs step outward in five tiers, so the silhouette tapers
 *              instead of running parallel. This is the single biggest tell.
 *   portals    openings between the struts grow toward the base, matching the
 *              real proportions — they are not evenly divided.
 *   struts     deep bands spanning the full width, with their own banding, not
 *              hairlines.
 *   fluting    the Art Deco channels down each leg face. Close up this is what
 *              the tower actually looks like.
 *   bracing    diagonal cross-bracing in the section below the roadway.
 */

const LEN = 1120; // the drawing's own units; it stretches to the column
const W = 168; // across it

type Tier = {
  x0: number;
  x1: number;
  /** Outer edge of the tower across its width, and how thick each leg is. */
  outer: number;
  leg: number;
};

/** Five tiers, stepping outward toward the base. */
const TIERS: Tier[] = [
  { x0: 0, x1: 196, outer: 34, leg: 25 },
  { x0: 196, x1: 380, outer: 29, leg: 27 },
  { x0: 380, x1: 592, outer: 24, leg: 29 },
  { x0: 592, x1: 838, outer: 19, leg: 31 },
  { x0: 838, x1: LEN, outer: 14, leg: 33 },
];

/** Struts: deep bands spanning the full width. The fourth is the roadway. */
const STRUTS = [
  { x: 150, w: 46 },
  { x: 334, w: 46 },
  { x: 546, w: 46 },
  { x: 786, w: 52 },
  { x: 1052, w: 44 },
];

const RED = "#E63F2C";
const DEEP = "#B32C1A";

function tierAt(x: number): Tier {
  return TIERS.find((t) => x >= t.x0 && x < t.x1) ?? TIERS[TIERS.length - 1];
}

export function TowerDivider({ height = 132 }: { height?: number }) {
  return (
    <div aria-hidden="true" className="w-full overflow-hidden">
      <svg
        className="mx-auto block w-full"
        style={{ maxWidth: COL, height }}
        viewBox={`0 0 ${LEN} ${W}`}
        preserveAspectRatio="none"
        fill="none"
      >
        {TIERS.map((t, i) => {
          const top = t.outer;
          const bot = W - t.outer;
          const len = t.x1 - t.x0;
          // Fluting — Art Deco channels running the length of each leg face.
          const flutes = [0.3, 0.5, 0.7];
          return (
            <g key={i}>
              {/* the two legs */}
              <rect x={t.x0} y={top} width={len} height={t.leg} fill={RED} />
              <rect x={t.x0} y={bot - t.leg} width={len} height={t.leg} fill={RED} />
              {/* channels */}
              {flutes.map((f) => (
                <g key={f}>
                  <line
                    x1={t.x0}
                    y1={top + t.leg * f}
                    x2={t.x1}
                    y2={top + t.leg * f}
                    stroke={DEEP}
                    strokeWidth={1.5}
                  />
                  <line
                    x1={t.x0}
                    y1={bot - t.leg * f}
                    x2={t.x1}
                    y2={bot - t.leg * f}
                    stroke={DEEP}
                    strokeWidth={1.5}
                  />
                </g>
              ))}
            </g>
          );
        })}

        {/* diagonal bracing in the bay below the roadway */}
        {(() => {
          const t = TIERS[4];
          const a = t.outer + t.leg;
          const b = W - t.outer - t.leg;
          const x0 = 838;
          const x1 = 1052;
          const step = (x1 - x0) / 3;
          return Array.from({ length: 3 }, (_, i) => {
            const sx = x0 + i * step;
            return (
              <g key={i}>
                <line x1={sx} y1={a} x2={sx + step} y2={b} stroke={RED} strokeWidth={3} />
                <line x1={sx} y1={b} x2={sx + step} y2={a} stroke={RED} strokeWidth={3} />
              </g>
            );
          });
        })()}

        {/* struts — full-width bands with their own banding */}
        {STRUTS.map((s) => {
          const t = tierAt(s.x + 1);
          const top = t.outer;
          const bot = W - t.outer;
          return (
            <g key={s.x}>
              <rect x={s.x} y={top} width={s.w} height={bot - top} fill={RED} />
              <line x1={s.x + 6} y1={top} x2={s.x + 6} y2={bot} stroke={DEEP} strokeWidth={2} />
              <line
                x1={s.x + s.w - 6}
                y1={top}
                x2={s.x + s.w - 6}
                y2={bot}
                stroke={DEEP}
                strokeWidth={2}
              />
            </g>
          );
        })}

        {/* the cap at the tower's top */}
        <rect x={0} y={TIERS[0].outer - 7} width={30} height={W - 2 * TIERS[0].outer + 14} fill={RED} />
      </svg>
    </div>
  );
}
