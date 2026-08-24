import type { Metadata } from "next";
// The palette lives on :root in the home page's stylesheet, and these routes use
// the same `.bay` root class so they inherit the body override and ::selection
// with it. Imported here rather than copied: two palettes is how two pages start
// disagreeing about what grey means.
import "../../home.css";

/**
 * Unlinked and noindex, on purpose.
 *
 * These are real URLs you can send to a maintainer for feedback today, but the
 * prompts have not been run end to end against a live agent yet, and a template
 * whose first click fails is worse than no template. Drop the robots block and
 * add the home-page teaser when each one has actually been deployed.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function TemplatesLayout({ children }: { children: React.ReactNode }) {
  return children;
}
