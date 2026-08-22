"use client";

import type { ReactNode } from "react";
import { Copy, Eye, ArrowRight, Plus, RefreshCw } from "lucide-react";
import { Button } from "./Button";

/**
 * The structure is squared and the parts inside it are rounded. That split is
 * the whole system: a 90° edge reads as fixed architecture, a curved one reads
 * as something you can act on. Cells share one hairline rather than each
 * drawing its own border, so a screen is one ruled surface instead of a tray
 * of floating tiles.
 */

/**
 * Blocks on a ground, not cells in a table.
 *
 * The container is the line colour and the blocks are white, separated by a 1px
 * gap — so the "lines" are simply the ground showing between them. Because each
 * block is rounded, its corners pull the white back and expose more ground
 * exactly at the corners: at an interior crossing four roundings meet and open
 * a small four-pointed well, along an edge two meet and pinch. That shape is
 * negative space, so it is always perfectly registered — there is nothing
 * positioned that could drift out of line.
 *
 * The container stays square. Rounding it would turn the outer corners into a
 * card edge, while every other corner in the grid is a concave notch — the same
 * detail interrupted at the perimeter. Square outside plus rounded blocks keeps
 * one rule everywhere: the block is always rounded, the ground fills whatever
 * the rounding leaves. An outer corner is a quarter of the well, an edge is a
 * half, a crossing is the whole thing.
 */
export function CellGrid({ children }: { children: ReactNode }) {
  // bg-line, not bg-ground. `ground` used to be #E4E4E4 here — a hairline chosen
  // to be visible against white, sharing a name with the page ground it is not.
  // Now that `ground` means the page ground (#FAFAFA) it would have erased these
  // rules; `line` is the hairline token, one point from the value this was drawn
  // with.
  return (
    <div className="grid grid-cols-1 gap-px bg-line p-px sm:grid-cols-2">
      {children}
    </div>
  );
}

export function Cell({
  title,
  sub,
  children,
  className = "",
}: {
  title: string;
  sub: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`relative flex flex-col gap-1 rounded-xl bg-white p-6 ${className}`}>
      <div className="text-section text-ink">{title}</div>
      <div className="text-sub text-ink-2">{sub}</div>
      {children && <div className="mt-5">{children}</div>}
    </div>
  );
}

/**
 * Machine values live here and nowhere else — addresses, keys, commands.
 * The text is red.ink rather than the brand red: the brand value measures
 * 3.58:1 on this tint, which fails for text this small.
 */
export function TintRow({ value }: { value: string }) {
  return (
    <div className="flex h-12 items-center gap-2 rounded-xl bg-tint p-3">
      <div className="min-w-0 flex-1 truncate pr-2 font-mono text-val text-red-ink">
        {value}
      </div>
      <IconButton label="Reveal">
        <Eye size={16} strokeWidth={2} />
      </IconButton>
      <IconButton label="Copy">
        <Copy size={16} strokeWidth={2} />
      </IconButton>
    </div>
  );
}

export function IconButton({ label, children }: { label: string; children: ReactNode }) {
  return (
    <button
      aria-label={label}
      className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-2 transition-colors hover:bg-ink/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-red"
    >
      {children}
    </button>
  );
}

/** Fixed-width slot so avatars line up across rows regardless of count. */
function Avatar({ initials, i }: { initials: string; i: number }) {
  return (
    <span
      className="grid size-7 shrink-0 place-items-center rounded-full border border-white bg-tile font-mono text-[10px] text-ink-2"
      style={{ marginLeft: i === 0 ? 0 : -8 }}
    >
      {initials}
    </span>
  );
}

export function DashboardBlocks() {
  return (
    <CellGrid>
      <Cell
        title="Domain"
        sub="Link to your website"
      >
        <TintRow value="standup-notes.supersonic.cv" />
      </Cell>

      <Cell title="People" sub="Who can open this">
        <div className="flex items-center gap-3">
          <div className="flex">
            {["MA", "DV", "RK", "+2"].map((s, i) => (
              <Avatar key={s} initials={s} i={i} />
            ))}
          </div>
          <Button rest="white" hover="white" size="sm">
            <Plus size={15} strokeWidth={2} />
            Invite
          </Button>
        </div>
      </Cell>

      <Cell
        title="Database"
        sub="Your app's data and files"
      >
        <Button rest="white" hover="white" size="md">
          Open
          <ArrowRight size={16} strokeWidth={2} />
        </Button>
      </Cell>

      <Cell title="Updates" sub="Last shipped 2 hours ago">
        <div className="flex items-center gap-3">
          <Button rest="solid" hover="white" size="md">
            <RefreshCw size={16} strokeWidth={2} />
            Ship again
          </Button>
          <span className="inline-flex items-center gap-2 font-mono text-micro text-ink-2">
            <span className="size-1.5 rounded-full bg-red" />
            Running
          </span>
        </div>
      </Cell>
    </CellGrid>
  );
}
