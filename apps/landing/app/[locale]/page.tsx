import { notFound } from "next/navigation";
import { getMessages } from "@/lib/i18n";
import { DEFAULT_LOCALE, LOCALES, isLocale } from "@/lib/i18n/locales";
import Landing from "@/components/pages/Landing";
import "../home.css";

/**
 * The landing page's shell.
 *
 * A server component whose only job is to pick the catalogue and hand it over,
 * so only the language being read is serialised. Importing the catalogues into
 * the client component instead would put all six in every visitor's bundle.
 */

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export default function Page({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  const locale = isLocale(params.locale) ? params.locale : DEFAULT_LOCALE;
  return <Landing t={getMessages(locale)} locale={locale} />;
}
