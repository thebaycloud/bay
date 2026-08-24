import { notFound } from "next/navigation";
import { OG_CONTENT_TYPE, OG_SIZE, ogCard } from "@/lib/og";
import { cardCopy } from "@/lib/og/copy";
import { fill } from "@/lib/i18n";
import { TEMPLATES, templateBySlug } from "@/lib/templates";

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "Self-host it on Bay";

/** One card per template, drawn at build time alongside the pages. */
export function generateStaticParams() {
  return TEMPLATES.map((t) => ({ slug: t.slug }));
}

export default function Image({ params }: { params: { locale: string; slug: string } }) {
  const { t: m, locale } = cardCopy(params.locale);
  const t = templateBySlug(params.slug);
  // No template, no card. Drawing a generic one would put a plausible image
  // behind a URL that 404s.
  if (!t) notFound();
  return ogCard({ title: fill(m.templatePage.h1, { name: t.name }), locale });
}
