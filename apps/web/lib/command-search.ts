/**
 * Ranking what the command palette shows for a query.
 *
 * Kept apart from the component so the behaviour people actually complain about
 * — "I typed the slug and my app was not there" — is checkable without a browser.
 *
 * Deliberately substring matching, not fuzzy. Slugs are five random characters,
 * so a subsequence matcher makes almost every slug match almost every query and
 * the list stops being an answer. Someone typing `um2b6` means that app.
 */

export interface CommandItem {
  id: string;
  /** What the row reads as: an app's name, or an action like "New app". */
  label: string;
  /** The second line — an app's hostname. Also searched. */
  hint?: string;
  href: string;
}

/** Lower is better. Two ranks only: the query starts the text, or is inside it. */
function rank(item: CommandItem, query: string): number {
  const label = item.label.toLowerCase();
  const hint = (item.hint ?? "").toLowerCase();

  if (label.startsWith(query) || hint.startsWith(query)) return 0;
  if (label.includes(query) || hint.includes(query)) return 1;
  return -1;
}

export function filterCommands<T extends CommandItem>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];

  return items
    .map((item, index) => ({ item, index, rank: rank(item, q) }))
    .filter((r) => r.rank >= 0)
    // Sorting on the original index keeps the order the caller chose within a
    // rank — apps arrive newest-first and should stay that way.
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((r) => r.item);
}
