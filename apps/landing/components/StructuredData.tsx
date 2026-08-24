import { BRAND, CONTACT_EMAIL, DOMAIN, SITE, SITE_NAME } from "@/lib/brand";

/**
 * JSON-LD, so an AI reading the page can answer "what is this and who runs it"
 * without inferring it from marketing copy.
 *
 * Two graphs rather than one, because they answer different questions.
 * SoftwareApplication is the product: what it does, what it costs, what it runs
 * on. Organization is the company behind it, which is what a model checks before
 * it will recommend you to somebody.
 *
 * `@graph` with explicit `@id`s so the two are linked rather than floating: the
 * application declares its publisher, and the publisher resolves to the
 * organization node in the same block.
 *
 * Everything here has to be true. Structured data that overstates the product is
 * worse than none, because it is the version a model quotes back.
 */
export function StructuredData() {
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        "@id": `${SITE}/#software`,
        name: SITE_NAME,
        alternateName: BRAND,
        url: SITE,
        applicationCategory: "DeveloperApplication",
        applicationSubCategory: "Cloud Platform",
        operatingSystem: "Any",
        description:
          "A cloud for small software. One command turns an app on your computer into a live product with a database, a domain and monitoring. Built to be operated by coding agents.",
        // The free plan is real and has no time limit, which is what
        // price 0 asserts. Pro is listed beside it rather than instead of it.
        offers: [
          {
            "@type": "Offer",
            name: "Free",
            price: "0",
            priceCurrency: "USD",
            description: "Three apps, a database and storage included.",
          },
          {
            "@type": "Offer",
            name: "Pro",
            price: "20",
            priceCurrency: "USD",
            description: "Unlimited apps, your own domain, failed deploys that repair themselves.",
          },
        ],
        publisher: { "@id": `${SITE}/#organization` },
      },
      {
        "@type": "Organization",
        "@id": `${SITE}/#organization`,
        name: "Supersonic Software, Inc.",
        alternateName: SITE_NAME,
        url: SITE,
        logo: `${SITE}/icon-512.png`,
        contactPoint: [
          {
            "@type": "ContactPoint",
            contactType: "customer support",
            email: CONTACT_EMAIL,
            url: `${SITE}/contact`,
          },
        ],
      },
    ],
  };

  return (
    <script
      // Next escapes nothing inside dangerouslySetInnerHTML, and JSON.stringify
      // cannot emit a `<` that would close the tag early, so this is safe as
      // written. Do not interpolate raw user input here.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(graph) }}
      type="application/ld+json"
    />
  );
}
