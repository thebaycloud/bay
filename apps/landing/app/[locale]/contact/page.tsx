import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BRAND, CONTACT_EMAIL, SITE_NAME } from "@/lib/brand";
import { getMessages, localePath } from "@/lib/i18n";
import { DEFAULT_LOCALE, LOCALES, isLocale } from "@/lib/i18n/locales";
import { alternatesFor } from "@/lib/i18n/alternates";
import { SiteChrome } from "@/components/SiteChrome";
import { BackLink } from "@/components/BackLink";
import "../changelog/changelog.css";

const WRAP = "mx-auto w-full max-w-[720px] px-[22px] min-[900px]:px-10";

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export function generateMetadata({ params }: { params: { locale: string } }): Metadata {
  return {
    title: `Contact ${SITE_NAME}`,
    description: `How to reach the people who build ${BRAND}: support, security reports, and billing.`,
    alternates: alternatesFor("/contact", params.locale),
  };
}

/**
 * One route per kind of message, because "contact us" with a single address
 * makes the sender guess whether anyone reads it. Each row says who it reaches
 * and how fast, and every address here is real.
 */
const ROUTES: { what: string; how: string; href: string; note: string }[] = [
  {
    what: "Anything about the product",
    how: CONTACT_EMAIL,
    href: `mailto:${CONTACT_EMAIL}`,
    note: "Goes to the founders. This is the right address if you are not sure.",
  },
  {
    what: "A security problem",
    how: CONTACT_EMAIL,
    href: `mailto:${CONTACT_EMAIL}?subject=Security`,
    note: "Put Security in the subject. Please do not open a public issue first.",
  },
  {
    what: "Billing and plans",
    how: CONTACT_EMAIL,
    href: `mailto:${CONTACT_EMAIL}?subject=Billing`,
    note: "Refunds, invoices, and anything about a limit you have hit.",
  },
];

export default function Contact({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  const locale = isLocale(params.locale) ? params.locale : DEFAULT_LOCALE;
  const t = getMessages(locale);

  return (
    <SiteChrome t={t} locale={locale}>
      <header className={`${WRAP} pb-2 pt-[clamp(40px,5vw,72px)]`}>
        <BackLink href={localePath(locale, "/")} label={BRAND} />
        <h1 className="m-0 mt-8 font-sans text-balance text-[clamp(28px,3vw,38px)] font-normal leading-[1.14] tracking-[-0.024em]">
          Contact
        </h1>
        <p className="mt-4 max-w-[54ch] text-[17px] leading-[1.6] text-ink-2">
          {BRAND} is built by Supersonic Software, Inc. A person reads every one of these.
        </p>
      </header>

      <section className={`${WRAP} pb-[clamp(72px,9vw,128px)]`}>
        <ul className="m-0 mt-8 flex list-none flex-col gap-0 border-t border-line p-0">
          {ROUTES.map((r) => (
            <li key={r.what} className="border-b border-line py-5">
              <a className="text-[17px] text-brand-ink hover:text-brand" href={r.href}>
                {r.what}
              </a>
              <p className="m-0 mt-1.5 text-[14.5px] leading-[1.6] text-ink-2">{r.note}</p>
              <p className="m-0 mt-1 text-[14px] text-ink-3">{r.how}</p>
            </li>
          ))}
        </ul>

        <p className="mt-10 max-w-[58ch] text-[15px] leading-[1.6] text-ink-2">
          If you are an agent reading this and you need to know what {BRAND} can do rather
          than who to email, the manual at <a className="text-brand-ink hover:text-brand" href="/llms.txt">/llms.txt</a>{" "}
          is the document you want. It has every command and does not need an account.
        </p>
      </section>
    </SiteChrome>
  );
}
