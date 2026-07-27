import { extractPeople, type ScrapedPerson } from "./people";
import { actionPause, humanClick, scrollUntilExhausted } from "./human";
import { openReactionsModal } from "./reactions";
import { findAll, findOne, requireOne } from "./selectors";

export type ScrapeSource = "post_likers" | "post_commenters" | "search" | "connections";

export interface ScrapeResult {
  source: ScrapeSource;
  sourceRef: string;
  people: ScrapedPerson[];
}

/** Accumulates across scroll rounds, since virtualised rows unmount behind us. */
class PersonSink {
  private readonly bySlug = new Map<string, ScrapedPerson>();

  harvest(root: ParentNode): void {
    for (const person of extractPeople(root)) {
      // First sighting wins: a re-render can produce a partially-hydrated card
      // whose headline has not loaded yet, and overwriting would lose data.
      if (!this.bySlug.has(person.profileUrl)) {
        this.bySlug.set(person.profileUrl, person);
      }
    }
  }

  get size(): number {
    return this.bySlug.size;
  }

  all(): ScrapedPerson[] {
    return Array.from(this.bySlug.values());
  }
}

/**
 * Everyone who reacted to the post on the current page.
 *
 * The likers list is the warmest source we have — these people already engaged
 * with your content, so they are not really cold.
 */
export async function scrapePostLikers(limit = 500): Promise<ScrapeResult> {
  const modal = await openReactionsModal();
  const sink = new PersonSink();

  await scrollUntilExhausted(modal, () => sink.harvest(modal), {
    shouldStop: () => sink.size >= limit,
  });

  return {
    source: "post_likers",
    sourceRef: location.href,
    people: sink.all().slice(0, limit),
  };
}

/**
 * Everyone who commented on the post on the current page. Strictly warmer than
 * a liker — commenting costs more than tapping a reaction.
 */
export async function scrapePostCommenters(limit = 300): Promise<ScrapeResult> {
  const list = requireOne("commentsList");
  const sink = new PersonSink();

  // Comments paginate behind a button rather than on scroll, so exhaust that
  // first and harvest as we go.
  for (let i = 0; i < 40; i++) {
    sink.harvest(list);
    if (sink.size >= limit) break;
    const more = findOne("loadMoreComments");
    if (!more) break;
    await humanClick(more);
    await actionPause();
  }
  sink.harvest(list);

  return {
    source: "post_commenters",
    sourceRef: location.href,
    people: sink.all().slice(0, limit),
  };
}

/**
 * People-search results, following pagination.
 *
 * Deliberately capped low by default: search is the coldest source, and a
 * thousand-row pull is both worse for reply rate and more conspicuous.
 */
export async function scrapeSearchResults(limit = 200, maxPages = 10): Promise<ScrapeResult> {
  const sourceRef = location.href;
  const sink = new PersonSink();

  for (let page = 0; page < maxPages; page++) {
    const results = requireOne("searchResults");
    await scrollUntilExhausted(results, () => sink.harvest(results), {
      idleRounds: 2,
      maxRounds: 12,
      shouldStop: () => sink.size >= limit,
    });
    if (sink.size >= limit) break;

    const next = findOne("searchNextPage");
    if (!next || (next as HTMLButtonElement).disabled) break;
    await humanClick(next);
    await actionPause();
  }

  return { source: "search", sourceRef, people: sink.all().slice(0, limit) };
}

/** Existing 1st-degree connections — the pool for message-only sequences. */
export async function scrapeConnections(limit = 1000): Promise<ScrapeResult> {
  const list = requireOne("connectionsList");
  const sink = new PersonSink();

  await scrollUntilExhausted(list, () => sink.harvest(list), {
    shouldStop: () => sink.size >= limit,
    maxRounds: 200,
  });

  return {
    source: "connections",
    sourceRef: location.href,
    people: sink.all().slice(0, limit),
  };
}

export interface ProfileEnrichment {
  headline?: string;
  location?: string;
  currentRole?: string;
  currentCompany?: string;
  /** Short excerpts of recent activity — the only "recent post" context the copy generator sees. */
  recentActivity: string[];
  capturedAt: string;
}

/**
 * Read the profile page the tab is currently on.
 *
 * Everything here is strictly what is visible on the page. The generator is
 * told it may only reference these fields, which is what stops it inventing a
 * plausible-sounding detail about a real person.
 */
export function readProfilePage(): ProfileEnrichment {
  const text = (el: Element | null | undefined) =>
    el?.textContent?.replace(/\s+/g, " ").trim() || undefined;

  const experience = findOne("profileExperience");
  const firstRole = experience?.querySelector('span[aria-hidden="true"]');
  const roleLines = experience
    ? Array.from(experience.querySelectorAll('span[aria-hidden="true"]'))
        .map((el) => text(el))
        .filter((t): t is string => !!t)
        .slice(0, 4)
    : [];

  const activity = findAll("profileActivity")
    .flatMap((section) => Array.from(section.querySelectorAll('span[aria-hidden="true"]')))
    .map((el) => text(el))
    .filter((t): t is string => !!t && t.length > 25)
    .slice(0, 3);

  return {
    headline: text(findOne("profileHeadline")),
    location: text(findOne("profileLocation")),
    currentRole: text(firstRole) ?? roleLines[0],
    currentCompany: roleLines[1],
    recentActivity: activity,
    capturedAt: new Date().toISOString(),
  };
}
