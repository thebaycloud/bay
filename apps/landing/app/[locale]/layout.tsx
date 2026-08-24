import { BRAND, DOMAIN } from "@/lib/brand";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Bitter } from "next/font/google";
import { DEFAULT_LOCALE, LOCALES, isLocale } from "@/lib/i18n/locales";
import "../globals.css";

/**
 * The root layout, and it lives under [locale] rather than at app/ so that
 * <html lang> can come from the segment. Next allows the root layout to sit
 * inside a dynamic segment as long as every page is under it, which is why the
 * pages moved here and the machine routes (llms.txt, changelog.xml, agent.md)
 * stayed outside: those are files, not pages, and want no layout at all.
 */

// Gelica stand-in: Bitter is a free slab serif with real bold weights, close to
// Gelica's warm/soft feel. Swap to next/font/local with the Gelica files for the
// exact face.
const displaySerif = Bitter({
  weight: ["400", "600", "700"],
  subsets: ["latin"],
  variable: "--font-instrument-serif",
  display: "swap",
});

export const viewport = { width: "device-width", initialScale: 1 };

// Still English on every locale. The catalogues cover the pages; the site-level
// title and description are the next thing to move into them.
const TITLE = `${BRAND}: deploy your app in one command`;
const DESCRIPTION =
  "A cloud for small software. Point us at the app you built and we turn it into a real, live product, with the database and the domain, in one command. No infrastructure, no GitHub required.";

export const metadata: Metadata = {
  metadataBase: new URL(`https://${DOMAIN}`),
  title: TITLE,
  description: DESCRIPTION,
  // Each entry is its own drawing, not one file scaled, see docs/BRAND.md.
  // SVG first: browsers that support it get the sharp one at every zoom level.
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-16.png", type: "image/png", sizes: "16x16" },
    ],
    shortcut: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    type: "website",
    siteName: BRAND,
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
  twitter: { card: "summary_large_image", images: ["/og.png"] },
};

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export default function RootLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { locale: string };
}) {
  // Middleware rewrites unprefixed paths to /en, so anything reaching here with
  // a segment that is not a locale was asked for by hand and is not a page.
  if (!isLocale(params.locale)) notFound();
  const locale = isLocale(params.locale) ? params.locale : DEFAULT_LOCALE;

  return (
    <html
      lang={locale}
      className={`${GeistSans.variable} ${GeistMono.variable} ${displaySerif.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
