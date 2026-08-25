import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BRAND, CONTACT_EMAIL, DOMAIN, SITE_NAME } from "@/lib/brand";
import { getMessages, localePath } from "@/lib/i18n";
import { DEFAULT_LOCALE, LOCALES, isLocale } from "@/lib/i18n/locales";
import { alternatesFor } from "@/lib/i18n/alternates";
import { SiteChrome } from "@/components/SiteChrome";
import { BackLink } from "@/components/BackLink";
import "../changelog/changelog.css";

/**
 * What we hold, why, and how to make us stop holding it.
 *
 * Written from the code rather than from a template: every claim below names a
 * thing that exists in this repository — the session cookie in auth.config.ts,
 * the OAuth providers in auth.ts, the umami instance in lib/umami.ts, the Stripe
 * customer id on the users table. If one of those changes, this page is wrong
 * and has to change with it. A privacy page that describes a different product
 * is worse than none, because it is the version somebody quotes back.
 *
 * English only, like /about and /docs, and for the same reason.
 */
const WRAP = "mx-auto w-full max-w-[720px] px-[22px] min-[900px]:px-10";

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export function generateMetadata({ params }: { params: { locale: string } }): Metadata {
  return {
    title: `Privacy at ${SITE_NAME}`,
    description: `What ${BRAND} collects, why it collects it, who else sees it, and how to have it deleted.`,
    alternates: alternatesFor("/privacy", params.locale),
  };
}

export default function Privacy({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  const locale = isLocale(params.locale) ? params.locale : DEFAULT_LOCALE;
  const t = getMessages(locale);

  return (
    <SiteChrome t={t} locale={locale}>
      <header className={`${WRAP} pb-2 pt-[clamp(40px,5vw,72px)]`}>
        <BackLink href={localePath(locale, "/")} label={BRAND} />
        <h1 className="m-0 mt-8 font-sans text-balance text-[clamp(28px,3vw,38px)] font-normal leading-[1.14] tracking-[-0.024em]">
          Privacy
        </h1>
        <p className="mt-4 max-w-[54ch] text-[17px] leading-[1.6] text-ink-2">
          {BRAND} is built by Supersonic Software, Inc. This page says what we hold and why,
          in the same words we would use to describe it to each other.
        </p>
      </header>

      <section className={`${WRAP} prose pb-[clamp(72px,9vw,128px)]`}>
        <h2>What an account is</h2>
        <p>
          Signing in with Google or GitHub gives us your email address, your display name and
          your avatar URL, and nothing else from that account: the profile and the email
          address, no repositories and no contacts. Google also tells us whether it considers
          that address verified, which is what an &ldquo;anyone at acme.com&rdquo; rule needs
          in order to mean anything. If you connect GitHub so that a push can deploy, we also hold
          an installation token for the repositories you chose, and we can read those
          repositories and nothing outside them. Signing in with an email and a password
          instead stores a bcrypt hash; the password itself never reaches our database.
        </p>
        <p>
          The session is one <code>httpOnly</code> cookie on <code>{DOMAIN}</code>. It is not
          shared with anyone, it carries no profile data, and there is no advertising or
          cross-site tracking cookie on this site or in the dashboard.
        </p>

        <h2>What we hold about your apps</h2>
        <p>
          The code you ship, the build output, the environment variables you set, and the
          logs the running app writes. Secrets go into Google Secret Manager rather than into
          the container&apos;s configuration, and are mounted into the build and the running
          app from there; they are never printed in a log or shown to anyone who cannot
          already open the app&apos;s settings. Databases we provision for you are yours: we
          take backups so that we can restore them, and nothing else on our side reads what is
          in them.
        </p>
        <p>
          When a deploy fails, the repair agent reads the failing build log and the parts of
          the repository the failure points at, in order to propose a fix. That is a model
          call with your code in it: Gemini, through Vertex AI, on the same Google Cloud
          account that runs everything else here — so the code does not leave that account.
          It happens only on a failure, and only for your own app.
        </p>

        <h2>Visitors to the apps you publish</h2>
        <p>
          Every app gets an audience view: page views, referrers, countries, browsers. It runs
          on an instance of umami that we host ourselves, and the tag it uses is served from
          your app&apos;s own domain rather than from somebody else&apos;s CDN — so no request
          about your visitors goes anywhere but to us. There is no advertising identifier and
          no third-party cookie. On a paid plan the tag can be turned off entirely.
        </p>

        <h2>Who else sees any of it</h2>
        <p>
          Two companies, each for one job. Google Cloud runs the machines, the database, the
          storage and the model the repair agent calls. Stripe takes payments — we hold a
          customer id and the plan you are on, and never see a card number. That is the whole
          list; we do not sell data, and there is nobody on it whose job is marketing.
        </p>

        <h2>How long, and how to end it</h2>
        <p>
          Deleting an app deletes its containers, its images, its secrets and its database.
          Deleting your account does that for every app you own, cancels the subscription, and
          removes the account — immediately, from the dashboard, guarded by retyping your own
          email address. There is no waiting period and no soft delete to change your mind
          during. You can also ask for a copy of what we hold, or for it to be removed, by
          writing to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>; a person reads
          it.
        </p>

        <h2>Changes</h2>
        <p>
          If what we hold changes, this page changes on the same day, and the change is listed
          in the <a href="/changelog">changelog</a> like any other. It is versioned in the same
          repository as the product, so what it said on any given date is a matter of record.
        </p>
      </section>
    </SiteChrome>
  );
}
