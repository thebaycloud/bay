import { Bar, RailSkeleton } from "@/components/Skeleton";

/** Settings, while the account is being read. */
export default function Loading() {
  return (
    <div className="shell shell-side">
      <RailSkeleton />
      <div className="main">
        <header className="topbar topbar-flush">
          <div className="topbar-wrap"><div className="topbar-row" /></div>
        </header>
        <div className="content">
          <div className="wrap" style={{ padding: "26px 30px" }}>
            <Bar w="180px" h={26} />
            <Bar w="300px" h={13} mt={12} />
            <div className="sk-panel"><Bar w="100%" h={96} /></div>
            <div className="sk-panel"><Bar w="100%" h={140} /></div>
          </div>
        </div>
      </div>
    </div>
  );
}
