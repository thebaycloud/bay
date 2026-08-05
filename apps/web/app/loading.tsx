import { CardsSkeleton, RailSkeleton } from "@/components/Skeleton";

/**
 * What a navigation TO this page shows while it is being built.
 *
 * The Suspense boundary inside page.tsx covers a fresh load; this covers moving
 * here from somewhere else in the app, where Next has to render the route on the
 * server before it can hand anything over. Same shapes, so the two cases look
 * like one behaviour.
 */
export default function Loading() {
  return (
    <div className="shell shell-side">
      <RailSkeleton />
      <div className="main">
        <header className="topbar topbar-flush">
          <div className="topbar-wrap"><div className="topbar-row" /></div>
        </header>
        <div className="content">
          <div className="wrap"><CardsSkeleton /></div>
        </div>
      </div>
    </div>
  );
}
