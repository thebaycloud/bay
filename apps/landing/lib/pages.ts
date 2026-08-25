/**
 * Every page this site publishes, in one list.
 *
 * It existed already, inlined in `app/sitemap.ts`, which was fine while the
 * sitemap was the only thing that needed to know. Middleware needs it too now:
 * it has to recognise a path that matches no page *before* routing happens, so
 * that a terminal asking for one gets markdown back instead of a page of markup
 * it cannot read. A second hand-kept copy of this list would go stale the first
 * time somebody adds a page, so there is one copy and both import it.
 *
 * `index: false` is a page that exists and is not offered to a crawler. It still
 * belongs here: middleware asks "is this a page", not "should this be indexed",
 * and answering no for /templates would serve a 404 for a page that renders.
 */
export type Page = {
  path: string;
  priority: number;
  changeFrequency: "weekly" | "monthly";
  /** In the sitemap. False for anything carrying its own noindex. */
  index: boolean;
};

export const PAGES: Page[] = [
  { path: "/", priority: 1, changeFrequency: "weekly", index: true },
  { path: "/pricing", priority: 0.8, changeFrequency: "monthly", index: true },
  { path: "/docs", priority: 0.8, changeFrequency: "weekly", index: true },
  { path: "/changelog", priority: 0.6, changeFrequency: "weekly", index: true },
  { path: "/about", priority: 0.5, changeFrequency: "monthly", index: true },
  { path: "/contact", priority: 0.5, changeFrequency: "monthly", index: true },
  { path: "/privacy", priority: 0.4, changeFrequency: "monthly", index: true },
  // Noindex until a prompt has been run end to end; see templates/layout.tsx.
  { path: "/templates", priority: 0.4, changeFrequency: "weekly", index: false },
];

/**
 * Paths whose children are pages we cannot enumerate here: one per changelog
 * entry, one per template. Middleware treats anything under them as a page and
 * lets the router decide, which is the conservative direction — the worst case
 * is a bad slug getting the HTML 404 rather than the markdown one, and both are
 * a real 404.
 */
export const SECTIONS = ["/changelog/", "/templates/"];

/** Whether a locale-stripped path is something this site renders. */
export function isPublishedPath(path: string): boolean {
  const clean = path.length > 1 ? path.replace(/\/$/, "") : path;
  if (PAGES.some((p) => p.path === clean)) return true;
  return SECTIONS.some((s) => clean.startsWith(s) && clean.length > s.length);
}
