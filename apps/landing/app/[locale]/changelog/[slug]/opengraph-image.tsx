import { notFound } from "next/navigation";
import { OG_CONTENT_TYPE, OG_SIZE, ogCard } from "@/lib/og";
import { allEntries, entryBySlug, formatDate } from "@/lib/changelog";

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "Changelog entry";

/** Drafts are excluded by allEntries, so a draft gets no card. */
export function generateStaticParams() {
  return allEntries().map((e) => ({ slug: e.slug }));
}

export default function Image({ params }: { params: { slug: string } }) {
  const e = entryBySlug(params.slug);
  // A draft, or a slug that never existed. Falling back to a generic "Changelog"
  // card was worse than nothing: it drew a real-looking image for a page that
  // 404s, which is exactly how a draft leaks into a feed.
  if (!e) notFound();
  // The entries themselves are English, so this one card needs no catalogue.
  return ogCard({ eyebrow: formatDate(e.date), title: e.title });
}
