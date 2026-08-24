import { TopBar } from "@/components/TopBar";
import { Skeleton } from "@/components/ui/skeleton";
import { HeadSkeleton, ListSkeleton } from "@/components/Skeleton";

/**
 * What a navigation TO this page shows while it is being built.
 *
 * The Suspense boundary inside page.tsx covers a fresh load; this covers moving
 * here from somewhere else in the app, where Next has to render the route on the
 * server before it can hand anything over. Same shapes as the real page, so the
 * two cases look like one behaviour.
 */
export default function Loading() {
  return (
    <>
      <TopBar />
      <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-7 px-6 py-10">
        <HeadSkeleton />
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="ml-auto h-9 w-[132px] rounded-md" />
            <Skeleton className="h-9 w-[124px] rounded-md" />
            <Skeleton className="h-9 w-[104px] rounded-md" />
          </div>
          <ListSkeleton rows={5} />
          <Skeleton className="h-3.5 w-28" />
        </div>
      </div>
    </>
  );
}
