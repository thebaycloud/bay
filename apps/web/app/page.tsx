export const dynamic = "force-dynamic";

import Link from "next/link";
import { Suspense } from "react";
import { Plus } from "lucide-react";
import { Bracket } from "@/components/Bracket";
import { CommandPalette } from "@/components/CommandPalette";
import { Sidebar } from "@/components/Sidebar";
import { AccountBanner } from "@/components/AccountBanner";
import { AppsGrid, type App } from "@/components/AppsGrid";
import { CardsSkeleton, RailSkeleton } from "@/components/Skeleton";
import { currentUserId } from "@/lib/session";
import { listOwnedApps, type AppSort } from "@/lib/apps";
import { listActiveDeploys, lastDeploySummaries } from "@/lib/deploys";

/**
 * Read the app list here, on the server, so it ships inside the HTML.
 *
 * This page used to fetch in useEffect, which meant the list arrived after the
 * HTML, after 449 kB of JavaScript, and after hydration — the content of the page
 * was the last thing to appear. Reading it here removes that round trip entirely;
 * there is no HTTP hop at all, the server talks to Postgres directly.
 *
 * Failing means an empty list, never a failed page: the grid then behaves exactly
 * as the old client-fetching version did. Server rendering must not be able to make
 * this page worse than the one it replaced.
 */
async function initialApps(sort: AppSort): Promise<{ apps: App[]; error?: string }> {
  const uid = await currentUserId();
  if (!uid) return { apps: [] };
  try {
    const [owned, deploys, last] = await Promise.all([
      listOwnedApps(uid, sort), listActiveDeploys(uid), lastDeploySummaries(uid),
    ]);
    const known = new Set(owned.map((a) => a.slug));
    const building: App[] = deploys
      .filter((d) => !known.has(d.slug))
      .map((d) => ({
        slug: d.slug, name: d.name || d.slug, url: `https://${d.slug}.supersonic.cv`,
        ready: false, region: "us-central1", image: "",
        status: "building", stage: d.stage || "deploying…",
      }));
    const live: App[] = owned.map((a) => ({
      slug: a.slug, name: a.name, url: a.url, ready: a.ready,
      region: "us-central1", image: "",
      deployedAt: last[a.slug]?.at,
      deployMs: last[a.slug]?.durationMs ?? undefined,
      ...(a.status === "deploying" ? { status: "building", stage: "deploying…" } : {}),
      // A failed app is shown as failed, with the reason the deploy recorded.
      ...(a.status === "failed" ? { status: "failed", error: a.error } : {}),
    }));
    return { apps: [...building, ...live] };
  } catch (e) {
    return { apps: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The part that has to wait for Postgres.
 *
 * Split out so everything else — the rail, the bar, the heading — can be sent
 * while this is still running. Next streams the skeleton in its place and
 * swaps in the real markup when the query returns; the reader gets a page
 * immediately instead of a white screen for the length of a database round
 * trip.
 *
 * The rail is inside the boundary WITH the list on purpose: it counts the same
 * rows, and handing it the list the page already read is cheaper than letting
 * it fetch its own copy a moment later.
 */
async function AppsAndRail() {
  // The default order — most recently deployed — computed in SQL. A different
  // one is asked for through /api/apps, not through the address bar.
  const { apps, error } = await initialApps("deployed");
  return (
    <>
      <Sidebar active="apps" apps={apps} />
      <div className="main">
        <AccountBanner />
        <header className="topbar topbar-flush">
          <div className="topbar-wrap">
            <div className="topbar-row">
              <CommandPalette apps={apps} />
              <div className="spacer" />
              <Bracket>
                <Link href="/new" className="btn primary"><Plus size={14} />New app</Link>
              </Bracket>
            </div>
          </div>
        </header>
        <div className="content">
          <div className="wrap">
            <AppsGrid initial={apps} initialError={error} />
          </div>
        </div>
      </div>
    </>
  );
}

export default function Home() {
  return (
    <div className="shell shell-side">
      <Suspense fallback={<HomeShell />}>
        <AppsAndRail />
      </Suspense>
    </div>
  );
}

/** The same page with nothing in it yet — see components/Skeleton.tsx. */
function HomeShell() {
  return (
    <>
      <RailSkeleton />
      <div className="main">
        {/* The bar's shape, so the shell and the page have one silhouette:
            search on the left, New app closing it on the right. */}
        <header className="topbar topbar-flush">
          <div className="topbar-wrap">
            <div className="topbar-row">
              <div className="kbar" style={{ minWidth: 156 }} />
              <div className="spacer" />
              <Bracket><span className="btn primary" style={{ opacity: .55 }}>New app</span></Bracket>
            </div>
          </div>
        </header>
        <div className="content">
          <div className="wrap">
            <CardsSkeleton />
          </div>
        </div>
      </div>
    </>
  );
}
