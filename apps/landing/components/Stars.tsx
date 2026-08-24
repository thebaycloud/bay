"use client";

import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import { GITHUB_URL } from "@/lib/brand";

/**
 * The GitHub star pill.
 *
 * Renders the mark and the word immediately and slots the number in when it
 * arrives, rather than holding the whole pill back on a network call. If the
 * count never comes (rate limit, offline, GitHub down) the pill is simply a
 * GitHub link, which is a true thing to be.
 *
 * `1234` reads as `1.2k`: at this size the exact number is noise, and a pill
 * that changes width every time someone stars the repo is worse than one that
 * does not.
 */
function format(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
}

export function Stars({ className }: { className?: string }) {
  const [stars, setStars] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/stars")
      .then((r) => r.json())
      .then((d: { stars: number | null }) => {
        if (live && typeof d.stars === "number") setStars(d.stars);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  return (
    <a
      href={GITHUB_URL}
      target="_blank"
      rel="noreferrer"
      aria-label={stars === null ? "GitHub repository" : `${stars} stars on GitHub`}
      className={className}
    >
      {/* GitHub's mark, inline: one path is cheaper than pulling an icon set in
          for a single glyph, and lucide's github mark is a different drawing. */}
      <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.07-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A7.995 7.995 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
      </svg>
      <span>GitHub</span>
      {stars === null ? null : (
        <>
          <span aria-hidden className="h-3.5 w-px bg-current opacity-25" />
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Star size={12} strokeWidth={2.2} className="translate-y-[-0.5px]" />
            {format(stars)}
          </span>
        </>
      )}
    </a>
  );
}
