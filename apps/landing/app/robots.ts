import type { MetadataRoute } from "next";
import { SITE } from "@/lib/brand";

/**
 * There was no robots.txt at all, which is worse than the missing sitemap it is
 * usually mentioned beside: this file is where a crawler is told the sitemap
 * exists. Without it, discovery of anything not linked from the homepage is
 * whatever the crawler stumbles into.
 *
 * Nothing is disallowed. The one part of the site that should not be indexed,
 * /templates, says so in its own layout with a robots meta tag, which is the
 * stronger signal: Disallow here would stop a crawler reading the page, and a
 * page it cannot read is a page whose noindex it never sees.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/" }],
    sitemap: `${SITE}/sitemap.xml`,
    host: SITE,
  };
}
