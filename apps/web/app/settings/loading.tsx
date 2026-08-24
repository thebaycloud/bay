import { TopBar } from "@/components/TopBar";
import { GroupSkeleton, HeadSkeleton } from "@/components/Skeleton";

/** Settings, while the account is being read. Same shapes as the page. */
export default function Loading() {
  return (
    <>
      <TopBar />
      <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-7 px-6 py-10">
        <HeadSkeleton sub={280} w={140} />
        <GroupSkeleton rows={2} />
        <GroupSkeleton rows={5} />
        <GroupSkeleton rows={3} />
      </div>
    </>
  );
}
