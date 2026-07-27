/**
 * Pacing helpers. Everything that touches the page goes through these.
 *
 * Scraping fast is the single easiest way to get an account restricted: a human
 * cannot open a modal and page through 400 profiles in nine seconds. The
 * numbers below are deliberately unhurried.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Uniform random integer in [min, max]. */
export function jitter(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** A pause between reading one chunk of a list and asking for the next. */
export function scrollPause(): Promise<void> {
  return sleep(jitter(900, 2200));
}

/** A pause between discrete actions — opening a modal, clicking a page link. */
export function actionPause(): Promise<void> {
  return sleep(jitter(1800, 4200));
}

export interface ScrollOptions {
  /** Stop after this many consecutive scrolls that add no new height. */
  idleRounds?: number;
  /** Hard ceiling on scroll iterations, so a broken page cannot spin forever. */
  maxRounds?: number;
  /** Called after each scroll with the running item count, for progress UI. */
  onProgress?: (round: number) => void;
  /** Return true to stop early (e.g. the caller hit its own limit). */
  shouldStop?: () => boolean;
}

/**
 * Scroll a virtualised container until it stops growing.
 *
 * LinkedIn's lists recycle DOM nodes, so callers must harvest after each round
 * rather than reading the container once at the end — by then the earlier rows
 * have been unmounted.
 */
export async function scrollUntilExhausted(
  container: Element,
  onBatch: () => void,
  options: ScrollOptions = {},
): Promise<void> {
  const idleLimit = options.idleRounds ?? 3;
  const maxRounds = options.maxRounds ?? 120;

  let idle = 0;
  let lastHeight = -1;

  for (let round = 0; round < maxRounds; round++) {
    onBatch();
    options.onProgress?.(round);
    if (options.shouldStop?.()) return;

    const scrollable = scrollableAncestor(container);
    const before = scrollable.scrollHeight;
    scrollable.scrollTo({ top: scrollable.scrollHeight, behavior: "smooth" });
    await scrollPause();

    const after = scrollable.scrollHeight;
    // Compare against both the pre-scroll height and the previous round: a lazy
    // list sometimes appends after a beat, so one flat round is not the end.
    idle = after > before || after !== lastHeight ? 0 : idle + 1;
    lastHeight = after;
    if (idle >= idleLimit) {
      onBatch();
      return;
    }
  }
  onBatch();
}

/**
 * The element that actually scrolls. Modals scroll an inner div while the page
 * body does not move, so scrolling `window` in a modal silently does nothing.
 */
function scrollableAncestor(start: Element): Element {
  let node: Element | null = start;
  while (node) {
    const style = getComputedStyle(node);
    const scrolls = /(auto|scroll|overlay)/.test(style.overflowY);
    if (scrolls && node.scrollHeight > node.clientHeight + 4) return node;
    node = node.parentElement;
  }
  return document.scrollingElement ?? document.documentElement;
}

/** Click as a user would: focus, small pause, then dispatch. */
export async function humanClick(el: Element): Promise<void> {
  (el as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
  await sleep(jitter(300, 900));
  (el as HTMLElement).click();
  await sleep(jitter(600, 1400));
}
