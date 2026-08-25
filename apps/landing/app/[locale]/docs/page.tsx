import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BRAND, CLI, DOCS_HOST, DOCS_URL, GITHUB_URL, PKG, SITE_NAME } from "@/lib/brand";
import { getMessages, localePath } from "@/lib/i18n";
import { DEFAULT_LOCALE, LOCALES, isLocale } from "@/lib/i18n/locales";
import { alternatesFor } from "@/lib/i18n/alternates";
import { SiteChrome } from "@/components/SiteChrome";
import { BackLink } from "@/components/BackLink";
import { manual } from "@/lib/manual";
import "../changelog/changelog.css";

/**
 * The developer documentation, at the address a person guesses first.
 *
 * The manual was already written, complete, and served — at `/llms.txt`, to
 * agents and to terminals. What it was not, was findable. Somebody who has heard
 * of this product and wants to know how the CLI works types `/docs`, and until
 * now that was a 404: the documentation existed at a URL you had to already know
 * the convention for.
 *
 * So this is not a second set of documentation. It is `content/manual.md`,
 * rendered — the same file, the same words, the same day. See lib/manual.ts.
 *
 * The guides are a different document and live on Mintlify, at bay.mintlify.app.
 * This page links them rather than repeating them: the manual is the command
 * reference, complete and one screen long, and the guides are the long-form
 * walk-throughs. Both are linked from the top and the bottom of this page, so
 * neither is the one you have to already know about.
 *
 * English only, like the changelog and the about page: a command reference that
 * is three releases out of date in five languages is worse than one that is
 * current in one.
 */
const WRAP = "mx-auto w-full max-w-[860px] px-[22px] min-[900px]:px-10";

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export function generateMetadata({ params }: { params: { locale: string } }): Metadata {
  return {
    // The product name is in the title on purpose. This is the page somebody
    // reaches by searching the product's name and the word "docs", and a title
    // that says only "Documentation" is a title that matches nothing.
    title: `${SITE_NAME} documentation — the ${CLI} CLI, end to end`,
    description: `Developer documentation for ${SITE_NAME}: install the ${CLI} CLI from ${PKG}, ship an app, attach a database, set secrets, add a custom domain, and read the logs when a deploy fails.`,
    alternates: alternatesFor("/docs", params.locale),
  };
}

export default function Docs({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  const locale = isLocale(params.locale) ? params.locale : DEFAULT_LOCALE;
  const t = getMessages(locale);
  const { html, sections } = manual();

  return (
    <SiteChrome t={t} locale={locale}>
      <section className={`${WRAP} pb-2 pt-[clamp(40px,5vw,72px)]`}>
        <BackLink href={localePath(locale, "/")} label={BRAND} />
        <h1 className="m-0 mt-8 font-sans text-balance text-[clamp(28px,3vw,38px)] font-normal leading-[1.14] tracking-[-0.024em]">
          {SITE_NAME} documentation
        </h1>
        <p className="mt-4 max-w-[62ch] text-[17px] leading-[1.6] text-ink-2">
          Everything {BRAND} can be told to do, from a terminal. This is the same
          document an agent reads at{" "}
          <a className="text-brand-ink hover:text-brand" href="/llms.txt">
            /llms.txt
          </a>
          , rendered for a person — one source, so the two cannot drift.
        </p>
        <p className="mt-3 max-w-[62ch] text-[15px] leading-[1.6] text-ink-3">
          Looking for the guides rather than the commands — databases, secrets, custom
          domains, shipping from GitHub? Those are at{" "}
          <a className="text-brand-ink hover:text-brand" href={DOCS_URL}>
            {DOCS_HOST}
          </a>
          .
        </p>
      </section>

      {/* The section list is the table of contents and the machine-readable
          outline at once: every h2 in the manual, linked by the id lib/manual.ts
          gives it, so a section can be quoted by URL. */}
      <nav className={`${WRAP} pt-8`} aria-label="On this page">
        <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 border-y border-line p-0 py-4 text-[14.5px] text-ink-2">
          {sections.map((s) => (
            <li key={s.id}>
              <a className="hover:text-brand-ink" href={`#${s.id}`}>
                {s.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <section
        className={`${WRAP} prose pb-10 pt-10`}
        dangerouslySetInnerHTML={{ __html: html }}
      />

      <section className={`${WRAP} pb-[clamp(72px,9vw,128px)]`}>
        <div className="border-t border-line pt-6 text-[14.5px] text-ink-2">
          <p className="m-0">
            The guides, in twenty-two pages:{" "}
            <a className="text-brand-ink hover:text-brand" href={DOCS_URL}>
              {DOCS_HOST}
            </a>
            .
          </p>
          <p className="m-0 mt-2">
            The same document in other shapes:{" "}
            <a className="text-brand-ink hover:text-brand" href="/llms.txt">
              /llms.txt
            </a>{" "}
            in markdown (also at <code>/agents.md</code>, <code>/AGENTS.md</code> and{" "}
            <code>/cli.md</code>, and at the bare domain under <code>curl</code>),{" "}
            <a className="text-brand-ink hover:text-brand" href={GITHUB_URL}>
              the source on GitHub
            </a>
            , and{" "}
            <a
              className="text-brand-ink hover:text-brand"
              href={`https://www.npmjs.com/package/${PKG}`}
            >
              {PKG}
            </a>{" "}
            on npm.
          </p>
        </div>
      </section>
    </SiteChrome>
  );
}
