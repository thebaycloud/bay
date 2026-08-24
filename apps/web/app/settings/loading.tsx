import { TopBar } from "@/components/TopBar";
import { Skeleton } from "@/components/ui/skeleton";

/** Settings, while the account is being read. Same shapes as the page. */
export default function Loading() {
  return (
    <>
      <TopBar />
      <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-7 px-6 py-10">
        <header className="flex flex-col gap-2">
          <Skeleton className="h-8 w-[140px]" />
          <Skeleton className="h-4 w-[280px]" />
        </header>
        {[2, 4].map((rows, g) => (
          <section className="flex flex-col gap-2.5" key={g}>
            <Skeleton className="h-5 w-20" />
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {Array.from({ length: rows }).map((_, i) => (
                <div
                  className="flex items-center gap-3 border-b border-border px-4 py-3.5 last:border-0"
                  key={i}
                >
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="ml-auto h-4 w-24" />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
