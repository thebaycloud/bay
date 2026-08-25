import { BRAND, DOMAIN, SITE_NAME } from "@/lib/brand";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Bitter } from "next/font/google";
import { DEFAULT_LOCALE, LOCALES, isLocale } from "@/lib/i18n/locales";
import { StructuredData } from "@/components/StructuredData";
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

/** Kept beside the title it feeds, and the same words as the h1. */
const DEFAULT_TAGLINE = "The cloud for the agentic era";

export const viewport = { width: "device-width", initialScale: 1 };

// Still English on every locale. The catalogues cover the pages; the site-level
// title and description are the next thing to move into them.
// The h1's sentence, with the brand in front. The homepage title is the one
// place the product gets to say what it is in its own words rather than in
// keywords, and it should match what the page actually says.
const TITLE = `${BRAND} - ${DEFAULT_TAGLINE}`;
const DESCRIPTION =
  "A cloud for small software. Point us at the app you built and we turn it into a real, live product, with the database and the domain, in one command. No infrastructure, no GitHub required.";

export const metadata: Metadata = {
  metadataBase: new URL(`https://${DOMAIN}`),
  /**
   * `template` is what every child page's title runs through, so a page sets its
   * own subject and nothing else. It replaces six hand-written suffixes that had
   * drifted into three different separators, two of them em dashes.
   */
  title: { default: TITLE, template: `%s - ${SITE_NAME}` },
  description: DESCRIPTION,
  // Each entry is its own drawing, not one file scaled, see docs/BRAND.md.
  //
  // The 16px is a cut-down bridge: the full mark has a tower, two cables, twenty
  // hangers, a deck and sixteen rivets, and at 16px everything under about three
  // device pixels turns to mush. Rendered and looked at rather than assumed. From
  // 32px up the full drawing holds, so that is what the larger sizes carry.
  //
  // favicon.svg is the small drawing, not the full one, because a favicon is only
  // ever shown at tab size.
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
    siteName: SITE_NAME,
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
  // No `images` here on purpose. An explicit value beats the generated card, and
  // setting it pinned twitter:image to the old flat /og.png while og:image was
  // already the new one, so X showed a different picture from everywhere else.
  // Left off, Next fills twitter:image from opengraph-image.tsx.
  twitter: { card: "summary_large_image" },
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
      <head>
        {/* RFC 8631: where this site's API describes itself. It is the link
            relation a client follows to find a description from a page, which
            is the only path available to something that has the brand and not
            the API. The file is the same one app.thebay.cloud serves; see
            scripts/sync-openapi.mjs for why there are two copies. */}
        <link rel="service-desc" type="application/openapi+json" href="/openapi.json" />
      </head>
      <body>
        <StructuredData />
        {children}
      </body>
    </html>
  );
}
