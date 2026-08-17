import NextAuth from "next-auth";
import { authConfig } from "./auth.config";

export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  // Static image assets in /public are public by definition — favicons, the
  // apple-touch icon, the PWA icons and og.png. Without this they get caught by
  // auth and 307 to /login, so iOS and link-preview crawlers see a redirect
  // instead of an image. Listing extensions rather than filenames so new brand
  // assets don't have to be remembered here. See docs/BRAND.md.
  //
  // Fonts belong on that list for a stricter reason than the images do. The
  // panel injected into a hosted app asks us for Geist from the app's own
  // origin, and a font is always fetched in CORS mode with no credentials — so
  // it can never carry the session this matcher was protecting. Left off the
  // list it 307s to /login, the browser gets a redirect where a typeface should
  // be, and falls back silently: the panel renders in the system face and
  // nothing anywhere reports an error. Which is precisely what it did in
  // production, while /metal/*.webp beside it worked, because webp was listed
  // and woff2 was not.
  matcher: [
    "/((?!_next/static|_next/image|.*\\.(?:ico|svg|png|jpg|jpeg|gif|webp|woff|woff2|ttf|otf)$).*)",
  ],
};
