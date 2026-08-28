import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BRAND, DOMAIN, SITE_NAME } from "@/lib/brand";
import { getMessages, localePath } from "@/lib/i18n";
import { DEFAULT_LOCALE, LOCALES, isLocale } from "@/lib/i18n/locales";
import { alternatesFor } from "@/lib/i18n/alternates";
import { SiteChrome } from "@/components/SiteChrome";
import { BackLink } from "@/components/BackLink";
import "../changelog/changelog.css";

/**
 * English only for now, like the changelog. The chrome translates; the prose
 * does not, because a company description that is six months out of date in five
 * languages is worse than one that is current in one.
 */
const WRAP = "mx-auto w-full max-w-[720px] px-[22px] min-[900px]:px-10";

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export function generateMetadata({ params }: { params: { locale: string } }): Metadata {
  return {
    title: `About ${SITE_NAME}`,
    description: `What ${BRAND} is, who builds it, and why it is operated by coding agents rather than a dashboard.`,
    alternates: alternatesFor("/about", params.locale),
  };
}

export default function About({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  const locale = isLocale(params.locale) ? params.locale : DEFAULT_LOCALE;
  const t = getMessages(locale);

  return (
    <SiteChrome t={t} locale={locale}>
      <section className={`${WRAP} pb-2 pt-[clamp(40px,5vw,72px)]`}>
        <BackLink href={localePath(locale, "/")} label={BRAND} />
        <h1 className="m-0 mt-8 font-sans text-balance text-[clamp(28px,3vw,38px)] font-normal leading-[1.14] tracking-[-0.024em]">
          About {BRAND}
        </h1>
      </section>

      <section className={`${WRAP} prose pb-[clamp(72px,9vw,128px)]`}>
        <p>
          {BRAND} is a cloud for small software. You point it at an app on your computer and
          one command turns it into a live product: a URL people can open, a database that is
          backed up from the first deploy, file storage, and monitoring that tells you what
          broke in plain words.
        </p>
        <p>
          It is built to be operated by a coding agent rather than by a person clicking
          through a console. That is the whole design. The agent that wrote your app is
          already in the folder, already knows what the app needs, and does not get bored
          reading build logs. So {BRAND} has a command line and a manual written for
          machines, and the dashboard is somewhere you go afterwards rather than a step on
          the way.
        </p>
        <p>
          The manual lives at{" "}
          <a href="/llms.txt">
            {DOMAIN}/llms.txt
          </a>
          , and the same document answers at the bare domain when the thing asking is a
          terminal rather than a browser. Every command is in it. There is no separate
          signup flow to learn: the first deploy opens a browser once, you approve, and the
          build carries on in the same command.
        </p>
        <p>
          We support open source directly rather than by talking about it. Self-hosting a
          public repository under an OSI-approved licence is free for its first year, and
          there is nothing to claim: it is detected at deploy from the git remote.
        </p>
        <p>
          {BRAND} is built by Supersonic Software, Inc. If you want to reach us, the{" "}
          <a href={localePath(locale, "/contact")}>contact page</a> has the ways in.
        </p>
      </section>
    </SiteChrome>
  );
}
