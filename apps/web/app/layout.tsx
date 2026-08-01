import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Instrument_Serif } from "next/font/google";
import { SessionWrapper } from "@/components/SessionWrapper";
import { themeBootScript } from "@/lib/theme";
import "./globals.css";

const instrumentSerif = Instrument_Serif({
  weight: "400",
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
      className={`${GeistSans.variable} ${GeistMono.variable} ${instrumentSerif.variable}`}
    >
      {/* Restores the chosen theme before the first paint — see lib/theme.ts. */}
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body><SessionWrapper>{children}</SessionWrapper></body>
    </html>
  );
}
