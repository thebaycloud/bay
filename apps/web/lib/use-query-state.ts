"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

/**
 * A piece of screen state that lives in the query string.
 *
 * The workbench held its tab and its open screen in `useState`, so a reload
 * always landed you on the chat rail — somebody reading Analytics and pressing
 * ⌘R lost the screen they were reading. It is in the URL now, which also makes
 * the page linkable and the browser's back button mean something.
 *
 * WHY `history.pushState` AND NOT `router.push`
 *
 * `/apps/[slug]` is `force-dynamic`. A `router.push` to the same route with new
 * search params re-runs the server component — a network round trip and a fresh
 * render — to change which of two already-mounted panes is visible. The state is
 * held in React either way; the URL is a MIRROR of it, kept so a reload can
 * restore it. `history.pushState` writes that mirror without asking the server
 * anything, which is the documented way to do this in App Router.
 *
 * `push` and not `replace` by default, because the back button should undo the
 * navigation a person just made: leaving Analytics goes back to the list, not
 * back to the app list two levels up.
 *
 * The `popstate` listener is what makes that true. Without it, back would change
 * the URL and leave the screen where it was — the two would disagree, and the
 * URL would be lying about what you are looking at.
 */
export function useQueryState(
  key: string,
  fallback: string | null = null,
): readonly [string | null, (next: string | null, mode?: "push" | "replace") => void] {
  // Read through the router's hook rather than `window`, so the value is the
  // same on the server's first render as on the client's. Reading
  // `location.search` in a useState initialiser hydrates to a mismatch.
  const params = useSearchParams();
  const [value, setValue] = useState<string | null>(params.get(key) ?? fallback);

  useEffect(() => {
    const onPop = () =>
      setValue(new URLSearchParams(window.location.search).get(key) ?? fallback);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [key, fallback]);

  const set = useCallback(
    (next: string | null, mode: "push" | "replace" = "push") => {
      setValue(next);
      const p = new URLSearchParams(window.location.search);
      // The fallback is the absence of the parameter. A URL carrying `?tab=chat`
      // for the default state is noise in a link somebody sends.
      if (next === null || next === fallback) p.delete(key);
      else p.set(key, next);
      const q = p.toString();
      const url = window.location.pathname + (q ? `?${q}` : "");
      window.history[mode === "push" ? "pushState" : "replaceState"](null, "", url);
    },
    [key, fallback],
  );

  return [value, set] as const;
}
