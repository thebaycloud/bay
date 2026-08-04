export const dynamic = "force-dynamic";

import Link from "next/link";
import { Plus } from "lucide-react";
import { Bracket } from "@/components/Bracket";
import { CommandPalette } from "@/components/CommandPalette";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Sidebar } from "@/components/Sidebar";
import { TrialBanner } from "@/components/TrialBanner";
import { AppsGrid, type App } from "@/components/AppsGrid";
import { currentUserId } from "@/lib/session";
import { listOwnedApps } from "@/lib/apps";
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
async function initialApps(): Promise<{ apps: App[]; error?: string }> {
  const uid = await currentUserId();
  if (!uid) return { apps: [] };
  try {
    const [owned, deploys, last] = await Promise.all([
      listOwnedApps(uid), listActiveDeploys(uid), lastDeploySummaries(uid),
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
    }));
    return { apps: [...building, ...live] };
  } catch (e) {
    return { apps: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export default async function Home() {
  const { apps, error } = await initialApps();

  return (
    <div className="shell shell-side">
      {/* The page has already read the list; the rail should not read it a
          second time to count the same rows. */}
      <Sidebar active="apps" apps={apps} />
      <div className="main">
        <TrialBanner />
        {/*
          New app leads the bar, ahead of search. It was in the far corner and
          also repeated inside the page, so the one action a new account needs
          was drawn twice and sat where nothing else on the screen does. One
          copy, at the start of the line the eye already reads first.
        */}
        <header className="topbar">
          <Bracket>
            <Link href="/new" className="btn primary"><Plus size={13} />New app</Link>
          </Bracket>
          <CommandPalette apps={apps} />
          <div className="spacer" />
        </header>

        {/*
          The decorative rule is gone from this page. It was an empty div whose
          only job was to draw a line, and with the app list capped at 940px it
          was a line the width of the window sitting above a column narrower
          than it. The cards carry their own edges now.
        */}
        <div className="content">
          <div className="wrap">
            <AppsGrid initial={apps} initialError={error} />
          </div>
        </div>
      </div>

      <ThemeToggle />
    </div>
  );
}
