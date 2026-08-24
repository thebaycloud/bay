import { TopBar } from "@/components/TopBar";
import { Skeleton } from "@/components/ui/skeleton";
import { GroupSkeleton, UsageSkeleton } from "@/components/Skeleton";

/** Settings, while the account is being read. Same shapes as the page. */
export default function Loading() {
  return (
    <>
      <TopBar />
      <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-7 px-6 py-10">
        {/* No subtitle skeleton: the page has no subtitle any more. */}
        <Skeleton className="h-8 w-[140px]" />
        <GroupSkeleton rows={3} />
        <GroupSkeleton rows={1} />
        <UsageSkeleton />
        <GroupSkeleton rows={2} />
      </div>
    </>
  );
}
