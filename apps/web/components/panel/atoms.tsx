"use client";

import type { ComponentType, ReactNode } from "react";
import { Check, ChevronRight, Copy, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The panel's row vocabulary, ported from services/proxy/panel/cells.js and
 * atoms.js and then rebuilt as a list.
 *
 * A row is a title, a sub, and ONE live fact. That third part is the whole idea:
 * home is not a menu, it is eight facts you can act on, so a row with nothing
 * true to say says so in its sub rather than showing an empty slot.
 *
 * They are ROWS and not cards because the app list is rows, and this screen is
 * opened from that list. Same tile, same 15px name, same dimmed machine value
 * beside it, same right-aligned fact, same hover. Two products' worth of layout
 * for one product's worth of information was the only thing wrong with the cards.
 */

/**
 * One block, as a row.
 *
 * The same row the app list draws: an icon tile, a name, a dimmer machine value
 * beside it, the fact right-aligned, and a chevron. It was a two-column grid of
 * 132px cards, which spent a screen's height on eight facts and looked like a
 * different product from the list you arrive from.
 *
 * `onOpen` makes the whole row the button — not a chevron you have to hit —
 * exactly as a row in the app list is the link.
 */
export function Row({
  title,
  sub,
  icon: Icon,
  onOpen,
  /** A CHOICE, not a door: a tick when it is the current one, and no chevron. */
  picked,
  children,
}: {
  /** ReactNode so a row about a hostname can set it in mono without a prop. */
  title: ReactNode;
  sub?: ReactNode;
  /** The block's own mark, in the tile the app list draws beside a row. */
  icon?: ComponentType<{ className?: string }>;
  onOpen?: () => void;
  picked?: boolean;
  /** The fact. Right-aligned, where "9 days ago" sits in the app list. */
  children?: ReactNode;
}) {
  const body = (
    <>
      {Icon ? (
        <span className="flex size-7 shrink-0 items-center justify-center rounded-sm border border-border bg-ground text-ink-2">
          <Icon className="size-3.5" />
        </span>
      ) : null}
      <span className="shrink-0 text-[15px] font-[450] text-ink">{title}</span>
      {/* Hidden on narrow screens rather than wrapped — the fact on the right is
          what the row is for. */}
      {sub ? <span className="hidden min-w-0 truncate text-[13px] text-ink-3 md:block">{sub}</span> : null}
      {children ? <span className="ml-auto flex shrink-0 items-center gap-2.5 pl-3">{children}</span> : null}
      {picked !== undefined ? (
        <Check
          aria-hidden="true"
          className={cn("size-4 shrink-0", children ? "" : "ml-auto", picked ? "text-ink" : "opacity-0")}
          strokeWidth={2}
        />
      ) : onOpen ? (
        <ChevronRight
          aria-hidden="true"
          className={cn("size-4 shrink-0 text-ink-3", children ? "" : "ml-auto")}
          strokeWidth={2}
        />
      ) : null}
    </>
  );

  const shape =
    "flex w-full items-center gap-3 border-b border-border px-4 py-3.5 text-left last:border-0";

  if (!onOpen) return <div className={shape}>{body}</div>;
  return (
    <button
      className={cn(
        shape,
        "transition-colors hover:bg-tile focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-red",
        picked && "bg-tile",
      )}
      onClick={onOpen}
      type="button"
    >
      {body}
    </button>
  );
}

/** The bordered box the rows live in — the app list's table, with no header to
 *  label columns that hold a different kind of fact in every row. */
export function RowList({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">{children}</div>
  );
}

/**
 * A titled group of rows.
 *
 * Eight rows in one box is a list you read top to bottom every time. Two groups:
 * Overview is the app itself — where it is, who can reach it, what it is doing —
 * and Resources is what it was given: a database, its keys, an agent token.
 *
 * The title sits in the same place and weight as "All apps" over the app list.
 */
export function RowGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="px-0.5 text-[15px] text-ink">{title}</h2>
      <RowList>{children}</RowList>
    </section>
  );
}

/**
 * The alert, above the list.
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
    <Card className="flex flex-col gap-1 rounded-xl border-transparent bg-tint p-4 shadow-none">
      <div className="text-val leading-tight tracking-[-0.011em] text-red-ink">{title}</div>
      <div className="font-mono text-micro text-ink-2">{sub}</div>
      <div className="pt-3.5">
        <Button onClick={onAct} size="sm">
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
    <div className="flex items-center gap-1">
      <span className="min-w-0 truncate font-mono text-[13px] text-ink-2">{value}</span>
      <Button
        aria-label="Open"
        className="size-7 shrink-0 rounded-md text-ink-3 hover:text-ink"
        onClick={() => window.open(`https://${value}`, "_blank", "noreferrer")}
        size="icon-sm"
        variant="ghost"
      >
        <Eye className="size-3.5" />
      </Button>
      <Button
        aria-label="Copy"
        className="size-7 shrink-0 rounded-md text-ink-3 hover:text-ink"
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
