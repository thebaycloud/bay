/**
 * One app, as every list of them sees it.
 *
 * Lived in `components/AppsGrid.tsx`, which four files imported for this type and
 * nothing rendered — the screenshot grid it belonged to was replaced by
 * `AppsTable` and never deleted. It was also nine `supersonic.cv` literals in
 * markup no browser reaches, which is how a rename ends up looking incomplete in
 * a grep and being incomplete somewhere that matters.
 */
export interface App {
  slug: string; name: string; url: string; ready: boolean;
  region: string; image: string; status?: string; stage?: string;
  /** A screenshot captured at deploy time; absent until that pipeline exists. */
  thumbnail?: string;
  /** ISO instant the last deploy finished, and how long it ran. */
  deployedAt?: string;
  deployMs?: number;
  /** Why the last deploy failed. Present only when status is "failed". */
  error?: string;
}
