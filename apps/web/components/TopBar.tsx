"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { productName } from "@/lib/brand";
import { cn } from "@/lib/utils";

/**
 * The whole chrome, in 52px.
 *
 * What replaced a 252px side rail. That rail held an app switcher, a four-item nav
 * and a health summary — and two of the four items were the page you were already
 * on. The two things people used were the palette and the account menu, so those
 * are what stayed.
 */

/**
 * Where each item goes, and what counts as being there.
 *
 * `exact` for the app list, because `/` is a prefix of every route in the
 * product — without it, every page would light up Apps.
 */
const ITEMS: { href: string; label: string; exact?: boolean }[] = [
  { href: "/", label: "Apps", exact: true },
  { href: "/settings", label: "Settings" },
  { href: "/cli", label: "CLI" },
];

export function TopBar() {
  const path = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-card">
      <div className="mx-auto flex h-[52px] w-full max-w-[1080px] items-center gap-4 px-6">
        {/* The landing page's lockup, exactly: its own logo file, the same gap,
            the same weight and tracking. A red square with a letter in it was
            something I drew — the landing page is what the product looks like,
            and there is only one logo. */}
        <Link className="flex items-center gap-2.5" href="/">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt=""
            className="size-[26px] shrink-0"
            height={26}
            src="/logo-bay.svg"
            width={26}
          />
          <span className="whitespace-nowrap text-[17px] font-medium tracking-[-0.03em] text-ink">
            {productName()}
          </span>
        </Link>

        <nav className="flex items-center gap-1">
          {ITEMS.map((item) => {
            // Read from the URL. The active item used to be a literal — Apps was
            // always the dark one and the other two always dim — so the bar said
            // you were on the app list from every page in the product.
            const active = item.exact ? path === item.href : path.startsWith(item.href);
            return (
              <Link
                className={cn(
                  // Black, dimming on hover. The landing page's convention
                  // (SiteNav's TRIGGER: `text-ink … hover:text-ink-2`), and the
                  // reason the ACTIVE item is a filled chip rather than a darker
                  // word: with every link already black there is no darker left
                  // to go, so the current page is marked by its surface.
                  "rounded-md px-2.5 py-1.5 text-[14px] transition-colors",
                  active ? "bg-tile text-ink" : "text-ink hover:text-ink-2",
                )}
                href={item.href}
                key={item.href}
                // Announced, not just drawn. A colour and a fill say nothing to a
                // screen reader.
                {...(active ? { "aria-current": "page" as const } : {})}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Nothing on the right. Search moved down beside the rows it searches —
            it was 900px from them up here, and the table had its own box, so the
            screen carried two ways to find one app. */}
      </div>
    </header>
  );
}
