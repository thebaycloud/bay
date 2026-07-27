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

export const metadata: Metadata = {
  title: "Supersonic — Deploy your app in one click",
  description:
    "The cloud for vibecoders. Point us at the app you built and we turn it into a real, live product — database, domain, everything — in one click. No infra, no GitHub required.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} ${displaySerif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
