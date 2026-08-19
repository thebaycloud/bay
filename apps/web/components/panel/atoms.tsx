"use client";

import type { ReactNode } from "react";
import { ChevronRight, Copy, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The panel's cell vocabulary, ported from services/proxy/panel/cells.js and
 * atoms.js.
 *
 * A cell is a title, a sub, and ONE live fact. That third part is the whole idea:
 * home is not a menu, it is eight facts you can act on, so a cell with nothing
 * true to say says so in its sub rather than showing an empty slot.
 *
 * Built on shadcn's Card so the surface, border and radius come from one place,
 * with the panel's own rules on top: 14px/400 titles so the fact under a title
 * outweighs it, mono for machine values only, and green reserved for status.
 */

/** A title, a sub, and one fact. `onOpen` makes it a button with a chevron. */
export function Cell({
  title,
  sub,
  onOpen,
  wide,
  children,
}: {
  title: string;
  sub: string;
  onOpen?: () => void;
  wide?: boolean;
  /** The fact. Pushed to the bottom of the cell so a row of them lines up. */
  children?: ReactNode;
}) {
  const body = (
    <>
      {/* 14px/400. At 18px/500 a cell's title outweighed the fact under it, which
          is backwards for a panel whose whole job is the fact. */}
      <div className="text-val leading-tight tracking-[-0.011em] text-ink">{title}</div>
      <div className="text-sub text-ink-2">{sub}</div>
      {children ? <div className={cn("pt-3.5", wide ? "" : "mt-auto")}>{children}</div> : null}
      {onOpen ? (
        <ChevronRight
          aria-hidden="true"
          className="absolute right-4 top-4 size-4 text-ink-3"
          strokeWidth={2}
        />
      ) : null}
    </>
  );

  const shape = cn(
    "relative flex flex-col gap-1 rounded-xl border-border bg-card p-4 pb-4.5 text-left shadow-none",
    wide && "col-span-full",
    !wide && "min-h-[132px]",
    onOpen && "transition-colors hover:bg-ground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red",
  );

  if (!onOpen) return <Card className={shape}>{body}</Card>;
  // Card has no asChild in this registry version, so the button IS the card: it
  // takes the same classes rather than nesting a button inside a div, which would
  // put a click target inside a non-interactive box.
  return (
    <button className={cn(shape, "border")} onClick={onOpen} type="button">
      {body}
    </button>
  );
}

/**
 * The alert, above the grid and always full width.
 *
 * Tinted rather than bordered: it is the one thing on this screen that must be
 * unmistakable, and red is already the accent, so the difference has to be the
 * surface. This is why green is not a second accent — if red also meant
 * "running", nothing would be left that means something is wrong.
 */
export function AlertCell({
  title,
  sub,
  act,
  onAct,
}: {
  title: string;
  sub: string;
  act: string;
  onAct?: () => void;
}) {
  return (
    <Card className="col-span-full flex flex-col gap-1 rounded-xl border-transparent bg-tint p-4 shadow-none">
      <div className="text-val leading-tight tracking-[-0.011em] text-red-ink">{title}</div>
      <div className="font-mono text-micro text-ink-2">{sub}</div>
      <div className="pt-3.5">
        <Button className="rounded-full" onClick={onAct} size="sm">
          {act}
        </Button>
      </div>
    </Card>
  );
}

/**
 * A machine value on a tinted row, with the two things you ever do to one.
 *
 * The value is mono and uses --red-ink rather than the brand red: #E63F2C on tint
 * measures 3.58:1 and fails, which is the whole reason two reds exist.
 */
export function TintRow({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl bg-tint px-3.5 py-2.5">
      <span className="min-w-0 flex-1 truncate font-mono text-val text-red-ink">{value}</span>
      <Button
        aria-label="Open"
        className="size-7 shrink-0 rounded-full text-red-ink hover:bg-white"
        onClick={() => window.open(`https://${value}`, "_blank", "noreferrer")}
        size="icon-sm"
        variant="ghost"
      >
        <Eye className="size-3.5" />
      </Button>
      <Button
        aria-label="Copy"
        className="size-7 shrink-0 rounded-full text-red-ink hover:bg-white"
        onClick={() => navigator.clipboard?.writeText(value).catch(() => {})}
        size="icon-sm"
        variant="ghost"
      >
        <Copy className="size-3.5" />
      </Button>
    </div>
  );
}

/** A dot and a machine value. Green means live; red means something is wrong. */
export function StatusChip({ text, tone }: { text: string; tone: "green" | "red" | "grey" }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          tone === "green" && "bg-[var(--green)]",
          tone === "red" && "bg-red",
          tone === "grey" && "bg-ink-3",
        )}
      />
      <span className="font-mono text-micro text-ink-2">{text}</span>
    </span>
  );
}

/** Overlapping initials, so a row of people has something to look at. */
export function Avatars({ initials }: { initials: string[] }) {
  if (!initials.length) return null;
  return (
    <span className="flex">
      {initials.slice(0, 4).map((t, i) => (
        <span
          className="-ml-1 inline-flex size-6 items-center justify-center rounded-full border border-card bg-tile font-mono text-[10px] text-ink-2 first:ml-0"
          key={`${t}-${i}`}
        >
          {t}
        </span>
      ))}
    </span>
  );
}

/** A row of facts under a cell's sub. */
export function Chips({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2.5">{children}</div>;
}
