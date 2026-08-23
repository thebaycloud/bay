"use client";

import Link from "next/link";
import { CommandPalette } from "@/components/CommandPalette";
import type { App } from "@/components/AppsGrid";

/**
 * The whole chrome, in 52px.
 *
 * What replaced a 252px side rail. That rail held an app switcher, a four-item nav
 * and a health summary — and two of the four items were the page you were already
 * on. The two things people used were the palette and the account menu, so those
 * are what stayed.
 *
 * The mark links to the landing page rather than to `/`, which is what the mark on
 * every other page of this product does; the app list is one click along the bar.
 */
export function TopBar({ apps }: { apps: App[] }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-card">
      <div className="mx-auto flex h-[52px] w-full max-w-[1080px] items-center gap-4 px-6">
        <Link className="flex items-center gap-2" href="/">
          <span className="flex size-6 items-center justify-center rounded-md bg-red text-[13px] font-semibold text-white">
            B
          </span>
          <span className="text-[15px] font-[450] tracking-[-0.01em] text-ink">Bay</span>
        </Link>

        <nav className="flex items-center gap-1">
          <Link
            className="rounded-md px-2.5 py-1.5 text-[14px] text-ink transition-colors hover:bg-tile"
            href="/"
          >
            Apps
          </Link>
          <Link
            className="rounded-md px-2.5 py-1.5 text-[14px] text-ink-2 transition-colors hover:bg-tile hover:text-ink"
            href="/settings"
          >
            Settings
          </Link>
          <Link
            className="rounded-md px-2.5 py-1.5 text-[14px] text-ink-2 transition-colors hover:bg-tile hover:text-ink"
            href="/cli"
          >
            CLI
          </Link>
        </nav>

        <div className="ml-auto">
          <CommandPalette apps={apps} />
        </div>
      </div>
    </header>
  );
}
