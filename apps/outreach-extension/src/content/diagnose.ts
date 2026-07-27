import { SELECTORS, whichCandidate, type SelectorTarget } from "./selectors";
import { extractPeople } from "./people";

/**
 * A snapshot of what is actually on the page right now.
 *
 * Selectors can only be fixed against real markup, and real markup differs by
 * account, locale, and whichever A/B bucket LinkedIn put you in. Rather than
 * guess, this reports what matched, what did not, and a sample of the DOM
 * around the profile links — enough to repair `selectors.ts` from evidence.
 */

export interface TargetDiagnosis {
  target: string;
  matched: string | null;
  count: number;
  candidatesTried: number;
}

export interface Diagnosis {
  url: string;
  capturedAt: string;
  targets: TargetDiagnosis[];
  profileLinks: {
    inDocument: number;
    inOpenDialog: number;
  };
  openDialogs: Array<{
    classes: string;
    ariaLabel: string | null;
    profileLinks: number;
    textPreview: string;
  }>;
  /** What extraction would return right now, from the best available root. */
  extractedSample: Array<{ profileUrl: string; fullName?: string; headline?: string }>;
  /** Trimmed markup around the first few profile links — the repair material. */
  linkSamples: string[];
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Strip attributes that carry no structural signal but bloat the sample —
 * inline styles, tracking ids, and LinkedIn's giant urn data attributes.
 */
function trimmedMarkup(el: Element, max = 700): string {
  const clone = el.cloneNode(true) as Element;
  for (const node of [clone, ...Array.from(clone.querySelectorAll("*"))]) {
    for (const attr of Array.from(node.attributes)) {
      const keep =
        attr.name === "class" ||
        attr.name === "href" ||
        attr.name === "role" ||
        attr.name.startsWith("aria-") ||
        attr.name.startsWith("data-");
      if (!keep) node.removeAttribute(attr.name);
      // Long urn values tell us nothing and eat the budget.
      else if (attr.value.length > 120) node.setAttribute(attr.name, `${attr.value.slice(0, 120)}…`);
    }
  }
  return truncate(clone.outerHTML, max);
}

export function diagnose(): Diagnosis {
  const targets = Object.keys(SELECTORS) as SelectorTarget[];

  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
  const dialogWithPeople =
    dialogs.find((d) => d.querySelectorAll('a[href*="/in/"]').length > 0) ?? dialogs[0];

  // Extraction runs against the open dialog when there is one, because that is
  // what a likers/commenters scrape actually reads.
  const extractionRoot: ParentNode = dialogWithPeople ?? document;
  const anchors = Array.from(extractionRoot.querySelectorAll('a[href*="/in/"]'));

  return {
    url: location.href,
    capturedAt: new Date().toISOString(),
    targets: targets.map((target) => {
      const hit = whichCandidate(target);
      return {
        target,
        matched: hit?.candidate ?? null,
        count: hit?.count ?? 0,
        candidatesTried: SELECTORS[target].length,
      };
    }),
    profileLinks: {
      inDocument: document.querySelectorAll('a[href*="/in/"]').length,
      inOpenDialog: dialogWithPeople?.querySelectorAll('a[href*="/in/"]').length ?? 0,
    },
    openDialogs: dialogs.map((d) => ({
      classes: truncate(d.className, 200),
      ariaLabel: d.getAttribute("aria-label"),
      profileLinks: d.querySelectorAll('a[href*="/in/"]').length,
      textPreview: truncate(d.textContent ?? "", 200),
    })),
    extractedSample: extractPeople(extractionRoot).slice(0, 5),
    linkSamples: anchors.slice(0, 3).map((a) => {
      // Two levels up is normally the card wrapper — the level that decides
      // whether name and headline extraction can work.
      const context = a.parentElement?.parentElement ?? a;
      return trimmedMarkup(context);
    }),
  };
}
