"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Box,
  ChevronDown,
  MoreHorizontal,
  SlidersHorizontal,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ShipNew } from "@/components/ShipNew";
import { CommandPalette } from "@/components/CommandPalette";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { App } from "@/components/AppsGrid";
import { cn } from "@/lib/utils";

/**
 * The app list, as a list.
 *
 * Replaces the screenshot grid. That grid was a BROWSING surface — a picture per
 * app, 132px tall, built for a product where the dashboard was the place you
 * worked. Deploys happen in a terminal now, so this page is somewhere you check
 * state, and a picture of a running app answers no question anybody arrives with.
 *
 * What a row carries is therefore the smallest set that answers "is it fine?":
 * the name, its state, where it lives, when it last shipped. Everything else is
 * behind the row (the workbench) or behind `…`, which is the only way a dense list
 * stays dense — the previous rows grew to four visible buttons each.
 */

type SortKey = "recent" | "oldest" | "name";
type Bucket = "live" | "building" | "failed";

function bucketOf(a: App): Bucket {
  if (a.status === "failed") return "failed";
  if (a.status === "building" || a.status === "deploying" || a.status === "pending") return "building";
  return "live";
}

/** "2 days ago", and never a date nobody can subtract in their head. */
function ago(iso?: string): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export function AppsTable({ initial, initialError }: { initial: App[]; initialError?: string }) {
  const [sort, setSort] = useState<SortKey>("recent");

  const shown = useMemo(() => {
    const list = [...initial];
    const when = (a: App) => (a.deployedAt ? new Date(a.deployedAt).getTime() : Date.now());
    if (sort === "name") list.sort((x, y) => (x.name || x.slug).localeCompare(y.name || y.slug));
    else if (sort === "oldest") list.sort((x, y) => when(x) - when(y));
    else list.sort((x, y) => when(y) - when(x));
    return list;
  }, [initial, sort]);

  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-7 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-[28px] font-[450] tracking-[-0.02em] text-ink">Your apps</h1>
        <p className="text-[15px] text-ink-2">Create and browse your Bay apps</p>
      </header>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] text-ink">All apps</span>
          <span className="text-[14px] text-ink-3">{initial.length}</span>

          <div className="ml-auto flex items-center gap-2">
            <CommandPalette apps={initial} />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button className="gap-1.5" size="sm" variant="outline">
                  {sort === "name" ? "Name" : sort === "oldest" ? "Oldest" : "Last shipped"}
                  <ChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setSort("recent")}>Last shipped</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSort("oldest")}>Oldest first</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSort("name")}>Name</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* The one filled button on the page. Everything else on this screen is
                looking; this is the only thing that makes something. Opens a dialog
                rather than navigating: choosing where the code comes from is a
                two-option question. */}
            <ShipNew />
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
            <span className="text-[13px] text-ink-3">Name</span>
            <span className="ml-auto text-[13px] text-ink-3">Last shipped</span>
            <span className="w-8" aria-hidden="true" />
          </div>

          {initialError ? (
            <Row>
              <p className="text-[14px] text-ink-2">
                Your apps could not be read just now. {initialError}
              </p>
            </Row>
          ) : shown.length === 0 ? (
            <Row>
              <p className="text-[14px] text-ink-2">
                Nothing here yet. Ship one and it appears in this list.
              </p>
            </Row>
          ) : (
            shown.map((a) => {
              const b = bucketOf(a);
              return (
                <div
                  className="group flex items-center gap-3 border-b border-border px-4 transition-colors last:border-0 hover:bg-tile"
                  key={a.slug}
                >
                  {/* The row IS the link. A row with four buttons on it is how the
                      last version got dense; the destination that matters is the
                      workbench, so the whole row goes there. */}
                  <Link
                    className="flex min-w-0 flex-1 items-center gap-3 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red"
                    href={`/apps/${a.slug}`}
                  >
                    <span
                      className={cn(
                        "flex size-7 shrink-0 items-center justify-center rounded-sm border border-border",
                        b === "failed" ? "bg-tint text-red" : "bg-ground text-ink-2",
                      )}
                    >
                      {b === "failed" ? <TriangleAlert className="size-3.5" /> : <Box className="size-3.5" />}
                    </span>

                    <span className="min-w-0 truncate text-[15px] font-[450] text-ink">{a.name || a.slug}</span>

                    {/* The address, which is the fact people actually come for, and
                        mono because it is a machine value. Hidden on narrow screens
                        rather than wrapped — the state matters more. */}
                    <span className="hidden min-w-0 truncate text-[13px] text-ink-3 sm:block">
                      {a.slug}.supersonic.cv
                    </span>
                  </Link>

                  <span className="shrink-0 text-[13px] text-ink-3 tabular-nums">
                    {b === "building" ? a.stage || "shipping…" : ago(a.deployedAt)}
                  </span>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        aria-label={`Actions for ${a.name || a.slug}`}
                        className="size-8 shrink-0 rounded-md text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                        size="icon-sm"
                        variant="ghost"
                      >
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <a href={`https://${a.slug}.supersonic.cv`} rel="noreferrer" target="_blank">
                          <ArrowUpRight className="size-3.5" />
                          Open the app
                        </a>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href={`/apps/${a.slug}`}>
                          <SlidersHorizontal className="size-3.5" />
                          Open the workbench
                        </Link>
                      </DropdownMenuItem>
                      {b === "failed" ? (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem asChild>
                            <Link href={`/apps/${a.slug}`}>
                              <TriangleAlert className="size-3.5" />
                              See what happened
                            </Link>
                          </DropdownMenuItem>
                        </>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            })
          )}
        </div>

        <p className="text-[13px] text-ink-3">
          Showing {shown.length} of {initial.length}
        </p>
      </div>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-8 text-center">{children}</div>;
}
