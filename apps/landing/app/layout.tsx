import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Bitter } from "next/font/google";
import "./globals.css";

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

const TITLE = "Supersonic — Deploy your app in one click";
const DESCRIPTION =
  "A cloud for small software. Point us at the app you built and we turn it into a real, live product — database, domain, everything — in one command. No infra, no GitHub required.";

export const metadata: Metadata = {
  metadataBase: new URL("https://supersonic.cv"),
  title: TITLE,
  description: DESCRIPTION,
  // Each entry is its own drawing, not one file scaled — see docs/BRAND.md.
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
    siteName: "Supersonic",
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
  twitter: { card: "summary_large_image", images: ["/og.png"] },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} ${displaySerif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
