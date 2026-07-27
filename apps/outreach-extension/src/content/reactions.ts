import { humanClick, sleep } from "./human";
import { SelectorMiss } from "./selectors";

/**
 * Finding and opening the reactions modal.
 *
 * An ordered list of CSS selectors was the wrong tool here. The social-counts
 * bar holds several visually similar buttons — reactions, comments, reposts,
 * send — and a selector that is merely *plausible* will happily match the wrong
 * one and click it. A miss is loud, but a wrong hit is silent.
 *
 * So instead of asking "which selector matches first", this asks "which element
 * on the page has the most evidence of being the reactions control", clicks the
 * best candidate, and then *verifies* a people dialog actually opened. If it
 * did not, it undoes the click and tries the next candidate. Being wrong is
 * recoverable; being confidently wrong is not.
 */

interface Candidate {
  el: Element;
  score: number;
  why: string[];
}

/** Buttons that live next to the reactions count and must never be clicked. */
const DISQUALIFYING = /comment|repost|share|send|follow|save|report|copy link/i;
const REACTION_WORDS = /reaction|reacted|like[sd]?\b/i;

function labelOf(el: Element): string {
  return `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`.trim();
}

function visible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Score every clickable element for how much it looks like the reactions
 * control. Evidence is additive so no single class name is load-bearing.
 */
export function reactionCandidates(root: ParentNode = document): Candidate[] {
  const clickable = Array.from(
    root.querySelectorAll('button, a[role="button"], [role="button"]'),
  ).filter(visible);

  const candidates: Candidate[] = [];

  for (const el of clickable) {
    const label = labelOf(el);
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    const why: string[] = [];
    let score = 0;

    // A control that names another action is that other action, whatever else
    // it looks like. Bail before it can accumulate points.
    if (DISQUALIFYING.test(label) || (text.length < 24 && DISQUALIFYING.test(text))) continue;

    if (el.hasAttribute("data-reaction-details")) {
      score += 5;
      why.push("data-reaction-details");
    }
    if (REACTION_WORDS.test(label)) {
      score += 4;
      why.push("aria-label mentions reactions");
    }
    // "49" on its own is the count itself.
    if (/^[\d,.]+$/.test(text)) {
      score += 2;
      why.push("text is a bare number");
    }
    if (el.closest('[class*="social-details-social-counts"]')) {
      score += 3;
      why.push("inside the social-counts bar");
    }
    if (el.querySelector('img[alt*="reaction" i], [data-test-icon*="reaction"], .reactions-icon')) {
      score += 2;
      why.push("contains a reaction icon");
    }
    // The count control sits in the post's own social bar, not the page chrome.
    if (el.closest("article, .feed-shared-update-v2, [data-urn]")) {
      score += 1;
      why.push("inside a post");
    }

    if (score > 0) candidates.push({ el, score, why });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

/** A dialog that actually contains profile links, or null. */
function openPeopleDialog(): Element | null {
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .artdeco-modal'));
  // Several dialogs are commonly open at once — the Messaging overlay is one,
  // and it precedes any modal you just opened in DOM order. Pick by content.
  return dialogs.find((d) => d.querySelector('a[href*="/in/"]')) ?? null;
}

async function waitForPeopleDialog(timeoutMs: number): Promise<Element | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const dialog = openPeopleDialog();
    if (dialog) return dialog;
    await sleep(400);
  }
  return null;
}

/** Dismiss whatever modal a wrong guess opened, so the next attempt starts clean. */
async function dismissModal(): Promise<void> {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(600);
  const closeButton = document.querySelector<HTMLElement>(
    '[role="dialog"] button[aria-label*="dismiss" i], [role="dialog"] button[aria-label*="close" i]',
  );
  if (closeButton) {
    closeButton.click();
    await sleep(600);
  }
}

/**
 * Open the reactions modal and return the element holding the list.
 *
 * Tries candidates best-first, verifying after each click. `attempts` is capped
 * because every wrong click is a real interaction on a real account.
 */
export async function openReactionsModal(attempts = 3): Promise<Element> {
  // Already open — happens when the user opened it by hand to diagnose.
  const existing = openPeopleDialog();
  if (existing) return existing;

  const candidates = reactionCandidates();
  if (!candidates.length) {
    throw new SelectorMiss("reactionsButton", [
      "no element on this page scored as a reactions control. " +
        "Are you on a post permalink (linkedin.com/feed/update/...) with at least one reaction?",
    ]);
  }

  const tried: string[] = [];
  for (const candidate of candidates.slice(0, attempts)) {
    tried.push(
      `[score ${candidate.score}] ${labelOf(candidate.el) || (candidate.el.textContent ?? "").trim().slice(0, 40)} — ${candidate.why.join(", ")}`,
    );

    await humanClick(candidate.el);
    const dialog = await waitForPeopleDialog(6000);
    if (dialog) return dialog;

    // Wrong control, or the modal opened empty. Reset before the next try.
    await dismissModal();
  }

  throw new SelectorMiss("reactionsButton", [
    `clicked ${tried.length} candidate(s), none opened a dialog containing profile links.\n` +
      tried.map((t) => `  · ${t}`).join("\n") +
      "\nRun Diagnose with the reactions modal open by hand to capture the real markup.",
  ]);
}
