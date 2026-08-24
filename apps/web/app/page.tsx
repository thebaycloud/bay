export const dynamic = "force-dynamic";

import Link from "next/link";
import { Suspense } from "react";
import { TopBar } from "@/components/TopBar";
import { HeadSkeleton, ListSkeleton } from "@/components/Skeleton";
import { AccountBanner } from "@/components/AccountBanner";
import { type App } from "@/components/AppsGrid";
import { AppsTable } from "@/components/AppsTable";
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
  // Sample rows, for looking at the list without a database behind it. Explicit
  // flag, and refused in production: a list that invents rows when Postgres is
  // unreachable is a dashboard that lies at the moment somebody most needs it not
  // to. This is not a fallback for a failed read — the failed read still says so.
  if (process.env.MOCK_APPS === "1" && process.env.NODE_ENV !== "production") {
    const { mockApps } = await import("@/lib/mock-apps");
    return { apps: mockApps() };
  }
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
/**
 * No side panel.
 *
 * The rail carried an app switcher, a nav with four destinations, and a health
 * summary. Two of those four are this page, one is settings and one is the CLI —
 * 252px of permanent chrome to reach two screens, on a product whose deploys
 * happen in a terminal. The account menu and the palette are what actually got
 * used, so they move into a thin top bar and the page gets the width back.
 */
async function Apps() {
  // The default order — most recently deployed — computed in SQL. A different
  // one is asked for through /api/apps, not through the address bar.
  const { apps, error } = await initialApps("deployed");
  return (
    <>
      <AccountBanner />
      <TopBar />
      <AppsTable initial={apps} initialError={error} />
    </>
  );
}

export default function Home() {
  return (
    <div className="min-h-screen bg-background">
      <Suspense fallback={<HomeShell />}>
        <Apps />
      </Suspense>
    </div>
  );
}

/** The same page with nothing in it yet — the loading.tsx shapes, so the two
 *  waiting states are one behaviour rather than two drawings. */
function HomeShell() {
  return (
    <>
      <TopBar />
      <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-7 px-6 py-10">
        <HeadSkeleton />
        <ListSkeleton rows={5} />
      </div>
    </>
  );
}
