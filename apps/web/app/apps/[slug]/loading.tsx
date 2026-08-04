import { CockpitSkeleton, RailSkeleton } from "@/components/Skeleton";

/** The cockpit's frame, while the app behind it is being read. */
export default function Loading() {
  return (
    <div className="shell shell-side">
      <RailSkeleton />
      <CockpitSkeleton />
    </div>
  );
}
