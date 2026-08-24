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

/**
 * Several keys at once, written in one go.
 *
 * `useQueryState` is one key per hook, and each setter reads `location.search`
 * fresh — so five of them called from one click leave five entries in the
 * history, and the back button then walks backwards through half a state nobody
 * ever saw. The database view moves a table, a sort column, a direction and three
 * filter parts together, which made that the normal case rather than the odd one.
 *
 * So: one state object, one listener, one `pushState` per patch. A key set to
 * null or "" is REMOVED, for the same reason the single-key version drops its
 * fallback — `?op=&value=` in a link somebody sends is noise that also reads as a
 * filter that is not there.
 *
 * `keys` must be a stable array — declare it as a module constant, not inline, or
 * the effect resubscribes on every render.
 */
export function useQueryRecord<K extends string>(
  keys: readonly K[],
): readonly [
  Record<K, string | null>,
  (patch: Partial<Record<K, string | null>>, mode?: "push" | "replace") => void,
] {
  const params = useSearchParams();
  const [value, setValue] = useState<Record<K, string | null>>(
    () => Object.fromEntries(keys.map((k) => [k, params.get(k)])) as Record<K, string | null>,
  );

  useEffect(() => {
    const onPop = () => {
      const p = new URLSearchParams(window.location.search);
      setValue(Object.fromEntries(keys.map((k) => [k, p.get(k)])) as Record<K, string | null>);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [keys]);

  const set = useCallback(
    (patch: Partial<Record<K, string | null>>, mode: "push" | "replace" = "push") => {
      setValue((prev) => ({ ...prev, ...patch }));
      const p = new URLSearchParams(window.location.search);
      for (const k of Object.keys(patch) as K[]) {
        const v = patch[k];
        if (v === null || v === undefined || v === "") p.delete(k);
        else p.set(k, String(v));
      }
      const q = p.toString();
      window.history[mode === "push" ? "pushState" : "replaceState"](
        null,
        "",
        window.location.pathname + (q ? `?${q}` : ""),
      );
    },
    [],
  );

  return [value, set] as const;
}
