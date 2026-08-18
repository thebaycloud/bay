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
  // `/film/*` is the third case, and it is the font case again with a different
  // extension. The ROOM — the waiting page the proxy serves at every app's own
  // address — loads the deploy film from here with a plain <script src>. A
  // script tag that receives a 307 to /login does not error, does not warn and
  // does not run: the room would simply keep its own drawing forever and no
  // signal would reach anyone. There is no session on that request and there
  // cannot be one; it is a static file, built by `npm run film`, identical for
  // every visitor.
  matcher: [
    "/((?!_next/static|_next/image|film/|.*\\.(?:ico|svg|png|jpg|jpeg|gif|webp|woff|woff2|ttf|otf)$).*)",
  ],
};
