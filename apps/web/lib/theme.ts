/**
 * Remembering which theme a person chose.
 *
 * The toggle used to set `data-theme` on <html> and stop there, so the choice
 * lived only in the current document. Any full page load — a reload, following a
 * link to /new, coming back to the dashboard tomorrow — dropped it, and the CSS
 * fell back to `@media (prefers-color-scheme)`. On a machine set to dark that
 * looked exactly like the toggle not working.
 *
 * Persisting is only half of it. Restoring the attribute from React would repaint
 * the page dark and then light, which is worse than not remembering. So the value
 * is read back by `themeBootScript`, a blocking script in <head> that runs before
 * the first paint.
 *
 * Three states, not two: "light", "dark", and *unchosen*. Unchosen leaves the
 * attribute off entirely so the system setting keeps deciding — writing a default
 * would silently opt everyone out of following their OS.
 */

export type Theme = "light" | "dark";

export const THEME_KEY = "supersonic:theme";

/** The slice of `localStorage` this needs — kept narrow so it is easy to fake. */
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

/**
 * The stored choice, or null when there is none.
 *
 * Storage access throws outright in Safari's private mode and wherever site data
 * is blocked, so every call is guarded. A page that cannot remember the theme is
 * a small loss; a page that fails to render is not.
 */
export function readTheme(storage: ThemeStorage): Theme | null {
  try {
    const stored = storage.getItem(THEME_KEY);
    return isTheme(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function writeTheme(storage: ThemeStorage, theme: Theme): void {
  try {
    storage.setItem(THEME_KEY, theme);
  } catch {
    /* see readTheme */
  }
}

/**
 * What one press of the toggle should produce.
 *
 * With no choice recorded yet the only sensible reading of a press is "not what
 * I am looking at", so it moves away from whatever the system setting is showing.
 */
export function nextTheme(current: Theme | null, prefersDark: boolean): Theme {
  const showing = current ?? (prefersDark ? "dark" : "light");
  return showing === "dark" ? "light" : "dark";
}

/**
 * Inlined into <head> and run before the body exists, so it must not reference
 * anything the app defines. Kept to one line for the same reason: it is parsed
 * and executed on the critical path of every page load.
 */
export const themeBootScript = `try{var t=localStorage.getItem(${JSON.stringify(
  THEME_KEY,
)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;
