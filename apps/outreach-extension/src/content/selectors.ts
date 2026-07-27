/**
 * Every CSS selector the extension uses lives here. Nothing else in the
 * codebase may call querySelector against LinkedIn markup.
 *
 * LinkedIn ships DOM changes constantly, so the rules are:
 *
 *   1. Each target is a *list* of candidates, tried in order. Semantic anchors
 *      (href shape, aria-label, role) come first because they survive a
 *      restyle; branded class names come last as hints.
 *   2. A miss throws `SelectorMiss` rather than returning null. The failure we
 *      cannot tolerate is the silent one — a scrape that "succeeds" with zero
 *      results looks identical to a prospect list that happens to be empty.
 */

export class SelectorMiss extends Error {
  constructor(
    readonly target: string,
    readonly candidates: readonly string[],
  ) {
    super(
      `selector "${target}" matched nothing. Tried: ${candidates.join(" | ")}. ` +
        `LinkedIn's markup has most likely changed — update src/content/selectors.ts.`,
    );
    this.name = "SelectorMiss";
  }
}

export const SELECTORS = {
  /**
   * The "N reactions" button on a post; clicking it opens the likers modal.
   * The `i` flag matters — LinkedIn ships both "49 reactions" and
   * "View 49 Reactions" depending on surface, and CSS attribute matching is
   * case-sensitive by default.
   */
  reactionsButton: [
    "button[data-reaction-details]",
    'button[aria-label*="reaction" i]',
    'button[aria-label*="reacted" i]',
    "button.social-details-social-counts__count-value",
    "button.social-details-social-counts__reactions-count",
    ".social-details-social-counts__reactions button",
    ".social-details-social-counts__reactions",
    ".social-details-social-counts__count-value",
  ],

  /** Scroll container of the likers modal. */
  reactorsModal: [
    '[role="dialog"] .scaffold-finite-scroll__content',
    ".social-details-reactors-modal__content",
    '[role="dialog"] .artdeco-modal__content',
    '[role="dialog"]',
  ],

  /** Comment list on a post permalink page. */
  commentsList: [
    ".comments-comments-list",
    ".social-details-social-activity",
    'section[class*="comments"]',
  ],

  /** "Load more comments" — comments paginate rather than infinite-scroll. */
  loadMoreComments: [
    'button.comments-comments-list__load-more-comments-button',
    'button[aria-label*="more comment"]',
    'button[class*="load-more-comment"]',
  ],

  /** People-search results list. */
  searchResults: [
    ".search-results-container",
    "ul.reusable-search__entity-result-list",
    'div[data-view-name="search-results"]',
    "main",
  ],

  /** Next page control on search results. */
  searchNextPage: ['button[aria-label="Next"]', "button.artdeco-pagination__button--next"],

  /** The 1st-degree connections list at /mynetwork/invite-connect/connections/. */
  connectionsList: [
    ".mn-connections",
    ".scaffold-finite-scroll__content",
    'section[class*="connections"]',
    "main",
  ],

  /** Profile page: the headline under the name. */
  profileHeadline: [
    ".text-body-medium.break-words",
    "div.ph5 .text-body-medium",
    'main section:first-of-type .text-body-medium',
  ],

  /** Profile page: the geographic location line. */
  profileLocation: [
    "span.text-body-small.inline.t-black--light.break-words",
    ".pv-text-details__left-panel .text-body-small",
  ],

  /** Profile page: the "Experience" section body. */
  profileExperience: [
    "#experience ~ div .pvs-list",
    'section:has(#experience) .pvs-list',
    "#experience",
  ],

  /** Profile page: the "Activity" / recent posts section. */
  profileActivity: ['section:has(#content_collections)', "#content_collections", '.pv-recent-activity-section'],
} as const;

export type SelectorTarget = keyof typeof SELECTORS;

/** First element matching any candidate, or null. */
export function findOne(target: SelectorTarget, root: ParentNode = document): Element | null {
  for (const candidate of SELECTORS[target]) {
    try {
      const el = root.querySelector(candidate);
      if (el) return el;
    } catch {
      // `:has()` and friends throw on older engines; fall through to the next.
    }
  }
  return null;
}

/** First element matching any candidate; throws SelectorMiss when none match. */
export function requireOne(target: SelectorTarget, root: ParentNode = document): Element {
  const el = findOne(target, root);
  if (!el) throw new SelectorMiss(target, SELECTORS[target]);
  return el;
}

/**
 * All elements matching the *first candidate that matches anything*.
 *
 * Deliberately not a union across candidates: candidates are alternative
 * spellings of the same target, so unioning them would double-count when two
 * spellings both still work.
 */
export function findAll(target: SelectorTarget, root: ParentNode = document): Element[] {
  for (const candidate of SELECTORS[target]) {
    try {
      const els = Array.from(root.querySelectorAll(candidate));
      if (els.length) return els;
    } catch {
      // Ignore unsupported selector syntax.
    }
  }
  return [];
}

/**
 * Report which targets currently match on this page. The panel surfaces this so
 * a DOM change shows up as a red row before it shows up as an empty campaign.
 */
export function selectorHealth(targets: SelectorTarget[]): Record<string, boolean> {
  const health: Record<string, boolean> = {};
  for (const t of targets) health[t] = findOne(t) !== null;
  return health;
}

/** Which candidate actually matched, and how many elements it hit. */
export function whichCandidate(
  target: SelectorTarget,
  root: ParentNode = document,
): { candidate: string; count: number } | null {
  for (const candidate of SELECTORS[target]) {
    try {
      const els = root.querySelectorAll(candidate);
      if (els.length) return { candidate, count: els.length };
    } catch {
      // Unsupported selector syntax on this engine.
    }
  }
  return null;
}
