import { Skeleton } from "@/components/ui/skeleton";

/**
 * The page before its data, as the shapes it will become.
 *
 * These are server components with no state and no effects on purpose: they are
 * what Next streams while an async boundary is still waiting, so they must cost
 * nothing to render and must never fetch anything themselves.
 *
 * They mirror the real layout's boxes rather than being generic grey bars. A
 * skeleton whose shape does not match what replaces it is worse than no
 * skeleton: the page jumps at the moment the reader has started reading it. That
 * is also why they live here rather than inside each loading.tsx — the same
 * shapes are used by a `loading.tsx` for a navigation AND by a page waiting on
 * its own client fetch, and two copies would drift.
 *
 * This module used to export `Bar`, `RailSkeleton` and `CardsSkeleton`, drawing
 * a 252px side rail and a grid of screenshot cards. Both left with the dashboard
 * rebuild; nothing imported them for weeks.
 */

/** A row in a bordered list: tile, name, and a fact on the right. */
export function RowSkeleton({ tile = true, w = 128 }: { tile?: boolean; w?: number }) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-4 py-3.5 last:border-0">
      {tile ? <Skeleton className="size-7 shrink-0 rounded-sm" /> : null}
      <Skeleton className="h-4" style={{ width: w }} />
      <Skeleton className="ml-auto h-4 w-24" />
    </div>
  );
}

/** The bordered box, with `rows` rows in it. */
export function ListSkeleton({ rows = 5, tile = true }: { rows?: number; tile?: boolean }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {Array.from({ length: rows }).map((_, i) => (
        // Widths vary so the block reads as a list of different names rather
        // than as a striped pattern.
        <RowSkeleton key={i} tile={tile} w={112 + ((i * 37) % 96)} />
      ))}
    </div>
  );
}

/** A page's title and one line under it. */
export function HeadSkeleton({ w = 180, sub = 260 }: { w?: number; sub?: number }) {
  return (
    <header className="flex flex-col gap-2.5">
      <Skeleton className="h-8" style={{ width: w }} />
      <Skeleton className="h-4" style={{ width: sub }} />
    </header>
  );
}

/** A titled group of rows, as it appears on /settings. */
export function GroupSkeleton({ rows = 3, tile = false }: { rows?: number; tile?: boolean }) {
  return (
    <section className="flex flex-col gap-2.5">
      <Skeleton className="h-5 w-20" />
      <ListSkeleton rows={rows} tile={tile} />
    </section>
  );
}

/**
 * The whole workbench, as geometry.
 *
 * Used by `loading.tsx` and by the page's own Suspense boundary, which used to
 * fall back to a bare `bg-background` — a blank screen for as long as Postgres
 * and Cloud Run took to answer, which is the case this shape exists for.
 */
export function WorkbenchSkeleton() {
  return (
    <div className="fixed inset-0 grid grid-rows-[52px_minmax(0,1fr)] bg-background">
      <header className="flex items-center gap-3 border-b border-border bg-card px-3.5">
        <Skeleton className="h-7 w-[132px] rounded-md" />
        <Skeleton className="h-8 w-[168px] rounded-lg" />
        <Skeleton className="ml-auto h-4 w-[168px]" />
      </header>
      <div className="grid min-h-0 grid-cols-[380px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col justify-end gap-3 border-r border-border bg-card p-3">
          <Skeleton className="h-[92px] w-full rounded-xl" />
        </aside>
        <div className="min-h-0 overflow-hidden bg-card" />
      </div>
    </div>
  );
}
