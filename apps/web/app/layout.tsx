import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Bitter } from "next/font/google";
import { SessionWrapper } from "@/components/SessionWrapper";
import { themeBootScript } from "@/lib/theme";
import "./globals.css";

/**
 * The wordmark's face, and it is the LANDING's face.
 *
 * These two apps both spelled "Supersonic" in `var(--serif)` and rendered two
 * different typefaces: the landing loads Bitter — a slab serif with real 600 and
 * 700 weights — under the variable name `--font-instrument-serif`, while this
 * app loaded Instrument Serif at weight 400 under the same name and asked for
 * 600, which the browser faked. Same declared tracking, visibly different
 * letterforms and rhythm.
 *
 * Matching the landing is the point of the wordmark, so this app loads what the
 * landing loads. The variable keeps its misleading name on purpose: renaming it
 * here without renaming it there would put the two apps back out of step, and
 * the name is wrong in exactly one place — the definition.
 */
const displaySerif = Bitter({
  weight: ["400", "600", "700"],
  subsets: ["latin"],
  variable: "--font-instrument-serif",
  display: "swap",
});

const TITLE = "Supersonic — Deploy anything in one click";
const DESCRIPTION =
  "Point us at the app you vibe-coded. We turn it into a real, live product — database, auth, everything — in one click. No infra, ever.";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL || "https://app.supersonic.cv"),
  title: TITLE,
  description: DESCRIPTION,
  // Each entry is its own drawing, not one file scaled — see docs/BRAND.md.
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
    siteName: "Supersonic",
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
  twitter: { card: "summary_large_image", images: ["/og.png"] },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} ${displaySerif.variable}`}
    >
      {/* Restores the chosen theme before the first paint — see lib/theme.ts. */}
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body><SessionWrapper>{children}</SessionWrapper></body>
    </html>
  );
}
