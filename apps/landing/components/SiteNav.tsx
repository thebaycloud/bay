"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { APP_URL, BRAND, GITHUB_REPO } from "@/lib/brand";
import { cn } from "@/lib/utils";
import { Stars } from "./Stars";

/**
 * The site's one navbar, shared by the landing page and the changelog.
 *
 * Two menus. Product scrolls to a section; Resources links out. The distinction
 * matters more than it looks: a `#hash` jumps, cannot be animated, and leaves the
 * fragment in the URL and in history, so Back returns you to a scroll position
 * rather than the page you came from. These items scroll instead, and from
 * another route they navigate first and scroll on arrival.
 */

const NAV_H = 64;

type Item =
  /** Scroll to an element id on the landing page. */
  | { label: string; to: string }
  /** An ordinary link. */
  | { label: string; href: string };

// One word each. A menu is a list of destinations, not a second set of
// headlines: the full sentence is waiting at the other end of the click.
// "Ship" rather than "Deploy" because ship is the product word (CONTEXT.md).
const PRODUCT: Item[] = [
  { label: "Ship", to: "ship" },
  { label: "Services", to: "services" },
  { label: "Fixes", to: "fixes" },
  { label: "Agents", to: "interfaces" },
];

const RESOURCES: Item[] = [
  { label: "Changelog", href: "/changelog" },
  { label: "Docs", href: "/llms.txt" },
  // PLACEHOLDER, like GITHUB_REPO itself: this points at a repo that is not ours
  // until the code is public. See lib/brand.ts.
  { label: "Community", href: `https://github.com/${GITHUB_REPO}/discussions` },
];

const BTN =
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[8px] " +
  "border px-[14px] font-sans text-[14px] font-[450] tracking-[-0.01em] h-[34px] transition-colors";

const TRIGGER =
  "inline-flex items-center gap-1 text-[13.5px] text-ink-2 transition-colors hover:text-ink";

function NavMenu({
  label,
  items,
  onScrollTo,
}: {
  label: string;
  items: Item[];
  onScrollTo: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Escape and an outside click both close it. Without the outside click the
  // menu survives a click on the page behind it, which reads as stuck.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <div
      ref={wrap}
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        className={TRIGGER}
      >
        {label}
        <ChevronDown
          size={13}
          strokeWidth={2.2}
          className={cn("transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <div
          role="menu"
          // Sits directly under the trigger with no gap, so crossing into it
          // never passes over dead space and closes the menu on the way.
          className="absolute left-1/2 top-full min-w-[168px] -translate-x-1/2 pt-3"
        >
          <div className="overflow-hidden rounded-[12px] border border-line bg-white p-1.5 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.18)]">
            {items.map((it) =>
              "href" in it ? (
                <Link
                  key={it.label}
                  href={it.href}
                  role="menuitem"
                  {...(it.href.startsWith("http")
                    ? { target: "_blank", rel: "noreferrer" }
                    : {})}
                  onClick={() => setOpen(false)}
                  className="block rounded-[8px] px-3 py-2 text-[14px] text-ink-2 transition-colors hover:bg-tile hover:text-ink"
                >
                  {it.label}
                </Link>
              ) : (
                <button
                  key={it.label}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onScrollTo(it.to);
                  }}
                  className="block w-full rounded-[8px] px-3 py-2 text-left text-[14px] text-ink-2 transition-colors hover:bg-tile hover:text-ink"
                >
                  {it.label}
                </button>
              )
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function SiteNav() {
  const [stuck, setStuck] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const onHome = pathname === "/";

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const scrollTo = useCallback(
    (id: string) => {
      // From another route there is nothing to scroll to yet, so hand the target
      // to the landing page and let it scroll once it has mounted.
      if (!onHome) {
        router.push(`/?to=${id}`);
        return;
      }
      const el = document.getElementById(id);
      if (!el) return;
      // Offset by the sticky bar, or the section lands underneath it.
      window.scrollTo({
        top: el.getBoundingClientRect().top + window.scrollY - NAV_H - 16,
        behavior: "smooth",
      });
    },
    [onHome, router]
  );

  return (
    <nav
      className={cn(
        "sticky top-0 z-50 h-16 border-b bg-ground/[0.88] backdrop-blur-[10px] backdrop-saturate-150 transition-colors",
        stuck ? "border-line" : "border-transparent"
      )}
    >
      <div className="relative mx-auto flex h-full w-full max-w-[1200px] items-center px-[22px] min-[900px]:px-10">
        <Link href="/" className="flex items-center gap-2.5" aria-label={`${BRAND} home`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-bay.svg" alt="" width={30} height={30} className="size-[30px] shrink-0" />
          <span className="whitespace-nowrap text-[20px] font-medium tracking-[-0.03em]">
            {BRAND}
          </span>
        </Link>

        {/* Centred on the VIEWPORT, so the links stay put whatever width the
            lockup and the button happen to be.

            Positioned by its own centre rather than as a full-width overlay: an
            inset-x-0 wrapper covers the lockup and the buttons, which then needs
            pointer-events-none to let clicks through, and that combination makes
            the menu triggers unreliable to hit. This box is only as wide as the
            links, so nothing is covered and nothing needs excluding. */}
        <div className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-7 min-[900px]:flex">
          <NavMenu label="Product" items={PRODUCT} onScrollTo={scrollTo} />
          <Link href="/templates" className={TRIGGER}>
            Templates
          </Link>
          <Link href="/pricing" className={TRIGGER}>
            Pricing
          </Link>
          <NavMenu label="Resources" items={RESOURCES} onScrollTo={scrollTo} />
        </div>

        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <Stars
            className={cn(
              BTN,
              "gap-2 border-line bg-white text-ink-2 hover:bg-tile hover:text-ink max-[560px]:hidden"
            )}
          />
          <a
            className={cn(BTN, "border-brand-ink bg-brand text-[#ffffff] hover:bg-[#cf3522]")}
            href={APP_URL}
          >
            My apps
          </a>
        </div>
      </div>
    </nav>
  );
}
