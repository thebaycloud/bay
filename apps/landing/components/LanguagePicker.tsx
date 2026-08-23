"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Globe } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The language control in the footer.
 *
 * Everything is driven off LOCALES, so a language is added by adding a line.
 *
 * `current` is hardcoded to the first entry because the site has no locale
 * routing yet: there is nowhere for a selection to come from and nowhere for it
 * to go. Wiring that up is what turns this from a list into a control.
 */
/**
 * Labels are in each language, not in English: a reader scanning for their own
 * language looks for the word they call it, not for "Chinese".
 *
 * Simplified and Traditional are separate entries rather than one "Chinese",
 * because they differ in vocabulary and not only in characters — software is
 * 软件 in the mainland and 軟體 in Taiwan, and one file cannot serve both.
 *
 * FONT: Geist covers Latin and Cyrillic, so English, Spanish and Russian render
 * in the site's own typeface. It has NO CJK, measured rather than assumed, so
 * zh-Hans, zh-Hant and ja fall back to whatever the reader's system supplies.
 * Those three want Noto Sans SC / TC / JP loaded alongside Geist before they
 * ship, or they will look like a different site rather than a translated one.
 */
const LOCALES: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "zh-Hans", label: "简体中文" },
  { code: "zh-Hant", label: "繁體中文" },
  { code: "es", label: "Español" },
  { code: "ja", label: "日本語" },
  { code: "ru", label: "Русский" },
];

export function LanguagePicker() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const current = LOCALES[0];

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
        aria-label="Language"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full bg-tile px-3 py-1.5 font-sans text-[13px] text-ink-2 transition-colors hover:text-ink"
      >
        <Globe size={13} strokeWidth={2} />
        {current.label}
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
                key={l.code}
                type="button"
                role="option"
                aria-selected={l.code === current.code}
                onClick={() => setOpen(false)}
                className="flex w-full items-center justify-between gap-3 rounded-[8px] px-3 py-2 text-left font-sans text-[14px] text-ink-2 transition-colors hover:bg-tile hover:text-ink"
              >
                {l.label}
                {l.code === current.code ? (
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
