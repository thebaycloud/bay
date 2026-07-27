/**
 * Turning a chunk of LinkedIn markup into people.
 *
 * The one thing LinkedIn cannot restyle away is that a link to a person points
 * at `/in/<slug>`. So instead of matching card classes — which change — this
 * anchors on the profile link and works outward. Class names appear only as
 * hints that make the common case cleaner; every one of them can vanish and the
 * extraction still returns a name and a URL.
 */

export interface ScrapedPerson {
  profileUrl: string;
  fullName?: string;
  headline?: string;
}

/** Noise LinkedIn interleaves with real text in person cards. */
const NOISE = [
  /^·$/,
  /^•$/,
  /^\d+(st|nd|rd|th)\+?$/i,
  /^(1st|2nd|3rd)\s*degree\s*connection$/i,
  /^status is (offline|online|reachable|away)$/i,
  /^view .*'s profile$/i,
  /^(connect|follow|following|message|pending|invited)$/i,
  /^verified$/i,
  /^premium$/i,
  /^influencer$/i,
  /^\s*$/,
];

export function cleanText(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isNoise(text: string): boolean {
  return NOISE.some((re) => re.test(text));
}

/**
 * Strip the surrounding phrase from an accessibility label.
 * "View Jane Doe's profile" -> "Jane Doe"
 */
export function nameFromAriaLabel(label: string | null | undefined): string | null {
  const text = cleanText(label);
  if (!text) return null;
  const patterns = [
    /^view\s+(.+?)'s\s+(profile|page)$/i,
    /^(.+?)'s\s+profile$/i,
    /^view\s+(.+)$/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1]) return cleanText(m[1]);
  }
  return text;
}

/**
 * LinkedIn renders a name twice: a `span[aria-hidden="true"]` for sighted users
 * and a visually-hidden duplicate for screen readers. Taking textContent of the
 * anchor therefore yields "Jane DoeJane Doe". Collapse that.
 */
export function dedupeDoubledName(text: string): string {
  const clean = cleanText(text);
  if (clean.length % 2 !== 0) return clean;
  const half = clean.length / 2;
  return clean.slice(0, half) === clean.slice(half) ? clean.slice(0, half) : clean;
}

const PROFILE_HREF = 'a[href*="/in/"]';

/** Class hints for the card wrapper, checked while walking up from the anchor. */
const CARD_HINTS = [
  "li",
  '[role="listitem"]',
  "article",
  "[data-chameleon-result-urn]",
  ".artdeco-list__item",
  ".entity-result",
  ".reusable-search__result-container",
];

/** Class hints for a person's headline/subtitle line, in preference order. */
const HEADLINE_HINTS = [
  ".artdeco-entity-lockup__subtitle",
  ".artdeco-entity-lockup__caption",
  ".entity-result__primary-subtitle",
  ".mn-connection-card__occupation",
  ".comments-post-meta__headline",
  ".t-14.t-black--light",
];

const NAME_HINTS = [
  ".artdeco-entity-lockup__title",
  ".entity-result__title-text",
  ".mn-connection-card__name",
  ".comments-post-meta__name-text",
];

function slugOf(href: string): string | null {
  const m = /\/in\/([^/?#]+)/.exec(href);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

/** Climb from the profile link to the smallest element that looks like a card. */
function cardRootFor(anchor: Element): Element {
  let node: Element | null = anchor;
  for (let depth = 0; node && depth < 8; depth++) {
    if (CARD_HINTS.some((hint) => matchesSafe(node!, hint))) return node;
    node = node.parentElement;
  }
  // No recognisable wrapper: a few levels up still beats the bare anchor,
  // because the headline is always a sibling rather than a child of the link.
  let fallback: Element = anchor;
  for (let i = 0; i < 3 && fallback.parentElement; i++) fallback = fallback.parentElement;
  return fallback;
}

function matchesSafe(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

function textOfHints(root: Element, hints: string[]): string {
  for (const hint of hints) {
    try {
      const el = root.querySelector(hint);
      const text = cleanText(el?.textContent);
      if (text && !isNoise(text)) return text;
    } catch {
      // Unsupported selector — try the next hint.
    }
  }
  return "";
}

function nameFor(anchor: Element, card: Element): string {
  // 1. The visible half of LinkedIn's doubled name markup.
  const visible = cleanText(anchor.querySelector('span[aria-hidden="true"]')?.textContent);
  if (visible && !isNoise(visible)) return visible;

  // 2. A card element whose class says "this is the name".
  const hinted = textOfHints(card, NAME_HINTS);
  if (hinted) return dedupeDoubledName(hinted);

  // 3. The accessibility label on the link itself.
  const aria = nameFromAriaLabel(anchor.getAttribute("aria-label"));
  if (aria && !isNoise(aria)) return aria;

  // 4. Whatever text the link carries.
  return dedupeDoubledName(anchor.textContent ?? "");
}

/**
 * Leaf text lines inside the card, in document order, with the name and the
 * usual chrome removed. Used when no headline class hint matches.
 */
function candidateLines(card: Element, exclude: string): string[] {
  const lines: string[] = [];
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode() as Element | null;
  while (node) {
    const hasElementChildren = node.children.length > 0;
    if (!hasElementChildren) {
      const text = cleanText(node.textContent);
      const insideControl = !!node.closest("button") || matchesSafe(node, PROFILE_HREF);
      if (
        text &&
        text !== exclude &&
        !isNoise(text) &&
        !insideControl &&
        text.length >= 3 &&
        text.length <= 300
      ) {
        lines.push(text);
      }
    }
    node = walker.nextNode() as Element | null;
  }
  return lines;
}

/**
 * Extract every distinct person linked from `root`.
 *
 * Deduped by profile slug because a single card links the same person from the
 * avatar and from the name.
 */
export function extractPeople(root: ParentNode): ScrapedPerson[] {
  const anchors = Array.from(root.querySelectorAll(PROFILE_HREF));
  const bySlug = new Map<string, ScrapedPerson>();

  for (const anchor of anchors) {
    const href = anchor.getAttribute("href");
    if (!href) continue;
    const slug = slugOf(href);
    // LinkedIn's own navigation ("/in/me", edit links) is not a prospect.
    if (!slug || slug === "me" || bySlug.has(slug)) continue;

    const card = cardRootFor(anchor);
    const fullName = nameFor(anchor, card);
    if (!fullName) continue;

    let headline = textOfHints(card, HEADLINE_HINTS);
    if (!headline) {
      headline = candidateLines(card, fullName)[0] ?? "";
    }

    bySlug.set(slug, {
      profileUrl: `https://www.linkedin.com/in/${slug}`,
      fullName,
      headline: headline || undefined,
    });
  }

  return Array.from(bySlug.values());
}
