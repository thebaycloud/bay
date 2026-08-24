import { TopBar } from "@/components/TopBar";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * What a navigation TO this page shows while it is being built.
 *
 * The Suspense boundary inside page.tsx covers a fresh load; this covers moving
 * here from somewhere else in the app, where Next has to render the route on the
 * server before it can hand anything over. Same shapes as the real page, so the
 * two cases look like one behaviour — which is why this had to be rewritten: it
 * was still drawing the 252px side rail the dashboard stopped having, so every
 * navigation flashed the previous design.
 */
export default function Loading() {
  return (
    <>
      <TopBar />
      <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-7 px-6 py-10">
        <header className="flex flex-col gap-2">
          <Skeleton className="h-8 w-[180px]" />
          <Skeleton className="h-4 w-[260px]" />
        </header>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="ml-auto h-9 w-[220px]" />
          </div>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                className="flex items-center gap-3 border-b border-border px-4 py-3.5 last:border-0"
                key={i}
              >
                <Skeleton className="size-7 shrink-0 rounded-sm" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="ml-auto h-4 w-24" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
