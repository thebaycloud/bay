"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Check, ChevronDown, Globe } from "lucide-react";
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_LABELS,
  isLocale,
  type Locale,
} from "@/lib/i18n/locales";
import { cn } from "@/lib/utils";

/**
 * The language control in the footer.
 *
 * The list lives in lib/i18n/locales.ts, not here: the routing and the message
 * catalogues read the same array, so a language cannot be in the menu and
 * missing from the site.
 */

/**
 * Splits a path into its locale and the page under it.
 *
 * English has no prefix, so `/pricing` is (en, /pricing) and `/ja/pricing` is
 * (ja, /pricing). Reading the locale from the path rather than from a prop keeps
 * this component out of every page's signature, and the path is the thing that
 * is actually true after a client-side navigation.
 */
function split(pathname: string): { locale: Locale; rest: string } {
  const [, first = "", ...tail] = pathname.split("/");
  if (isLocale(first) && first !== DEFAULT_LOCALE) {
    return { locale: first, rest: `/${tail.join("/")}` };
  }
  return { locale: DEFAULT_LOCALE, rest: pathname };
}

/** The same page under a different language. */
function href(locale: Locale, rest: string): string {
  const clean = rest === "/" ? "" : rest.replace(/\/$/, "");
  return locale === DEFAULT_LOCALE ? clean || "/" : `/${locale}${clean}`;
}

export function LanguagePicker({ label = "Language" }: { label?: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const pathname = usePathname();
  const { locale: current, rest } = split(pathname ?? "/");

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
    <div ref={wrap} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full bg-tile px-3 py-1.5 font-sans text-[13px] text-ink-2 transition-colors hover:text-ink"
      >
        <Globe size={13} strokeWidth={2} />
        {LOCALE_LABELS[current]}
        <ChevronDown
          size={12}
          strokeWidth={2.2}
          className={cn("transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        // Opens UPWARD: this sits in the last row of the footer, and a menu
        // dropping down from here would open below the end of the document.
        <div
          role="listbox"
          className="absolute bottom-full right-0 min-w-[172px] pb-2"
        >
          <div className="overflow-hidden rounded-[12px] border border-line bg-white p-1.5 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.18)]">
            {LOCALES.map((l) => (
              <button
                key={l}
                type="button"
                role="option"
                lang={l}
                aria-selected={l === current}
                onClick={() => {
                  setOpen(false);
                  if (l !== current) router.push(href(l, rest));
                }}
                className="flex w-full items-center justify-between gap-3 rounded-[8px] px-3 py-2 text-left font-sans text-[14px] text-ink-2 transition-colors hover:bg-tile hover:text-ink"
              >
                {LOCALE_LABELS[l]}
                {l === current ? (
                  <Check size={14} strokeWidth={2.2} className="shrink-0 text-ink-3" />
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
