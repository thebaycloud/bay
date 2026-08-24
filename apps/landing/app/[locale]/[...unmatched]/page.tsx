import { notFound } from "next/navigation";

/**
 * Every path that matched no page, routed into the locale's 404.
 *
 * Without this, an unmatched path falls through to Next's built-in 404, which is
 * a bare "This page could not be found" with no layout, no links and none of our
 * markup. The status was always correct; the body was a dead end.
 *
 * A catch-all rather than app/not-found.tsx because the root layout lives under
 * [locale]: a not-found at the app root would have no layout to render inside.
 * Static and dynamic routes both take precedence over a catch-all, so this only
 * ever runs when nothing else matched.
 */
export default function Unmatched(): never {
  notFound();
}
