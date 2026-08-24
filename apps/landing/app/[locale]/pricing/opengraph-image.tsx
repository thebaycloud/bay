import { OG_CONTENT_TYPE, OG_SIZE, ogCard } from "@/lib/og";
import { cardCopy } from "@/lib/og/copy";
import { LOCALES } from "@/lib/i18n/locales";

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "Pricing";

/** Prerendered per locale: a crawler should get a file, not a render. */
export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export default function Image({ params }: { params: { locale: string } }) {
  const { t, locale } = cardCopy(params.locale);
  return ogCard({ title: t.pricing.h1, locale });
}
