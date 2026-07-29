import NextAuth from "next-auth";
import { authConfig } from "./auth.config";

export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  // Static image assets in /public are public by definition — favicons, the
  // apple-touch icon, the PWA icons and og.png. Without this they get caught by
  // auth and 307 to /login, so iOS and link-preview crawlers see a redirect
  // instead of an image. Listing extensions rather than filenames so new brand
  // assets don't have to be remembered here. See docs/BRAND.md.
  matcher: ["/((?!_next/static|_next/image|.*\\.(?:ico|svg|png|jpg|jpeg|gif|webp)$).*)"],
};
