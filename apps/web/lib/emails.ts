/**
 * Every email we send, written in one place.
 *
 * Each function is the WHOLE message: its kind, its dedupe key, its subject and
 * its content. Scattering these across the routes that trigger them is how the
 * three that already existed ended up in three different voices, one of them
 * still naming a product we had renamed.
 *
 * The dedupe key is part of the message, not part of the plumbing, because only
 * the author of an email knows what "the same email" means for it. A welcome is
 * once per account. A card failure is once per dunning attempt — not once per
 * customer, or they'd never hear about the second card. A limit warning is once
 * per billing period.
 */
import { send, sendOrRetry, type SendResult } from "./email";
import { appUrl, controlPlaneUrl, productName } from "./brand";

const app = () => controlPlaneUrl();

/** The month a usage-scoped email belongs to, so next month's is a new email. */
function period(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ account */

/**
 * Welcome.
 *
 * The useful version of this email is not "welcome aboard" — it is the one
 * command that turns an account into a deployed app, because that is the only
 * thing a new account is for and the dashboard cannot paste itself into a
 * terminal.
 */
export function sendWelcome(o: { userId: string; email: string; name?: string | null }): Promise<SendResult> {
  const first = (o.name || "").trim().split(/\s+/)[0];
  return send({
    kind: "welcome",
    dedupeKey: `welcome:${o.userId}`,
    to: o.email,
    userId: o.userId,
    subject: `Welcome to ${productName()}`,
    content: {
      preheader: "Two commands and your app is on the internet.",
      heading: first ? `Welcome, ${first}` : `Welcome to ${productName()}`,
      blocks: [
        { p: `Your account is ready. ${productName()} deploys whatever is in a folder — no config file, no Dockerfile, no YAML.` },
        { label: "From your project directory:", code: "npm i -g @thebaycloud/cli\nbay deploy" },
        { p: "That reads your project, builds it, and gives you a URL. If the build fails, you get a fix prompt you can paste straight into your coding agent." },
      ],
      cta: { label: "Open the dashboard", url: app() },
      footnote: "Three apps are free, and stay free.",
    },
  });
}

/**
 * Password reset.
 *
 * The one email on this list where a failed delivery is an account lost: there
 * was no reset flow at all before this, so somebody who forgot their password
 * had no path back. Hence `sendOrRetry` rather than `send`.
 */
export function sendPasswordReset(o: { userId: string; email: string; token: string; expiresMinutes: number }): Promise<SendResult> {
  return sendOrRetry({
    kind: "password_reset",
    // The token, not the user: asking twice must send twice, or the second
    // request silently does nothing and the first link may already be lost.
    dedupeKey: `password_reset:${o.token.slice(0, 16)}`,
    to: o.email,
    userId: o.userId,
    subject: `Reset your ${productName()} password`,
    content: {
      preheader: `This link works for ${o.expiresMinutes} minutes.`,
      heading: "Reset your password",
      blocks: [{ p: "Click below to choose a new password. The link works once." }],
      cta: { label: "Choose a new password", url: `${app()}/reset?token=${encodeURIComponent(o.token)}` },
      footnote: `The link expires in ${o.expiresMinutes} minutes. If you didn't ask for this, you can ignore this email — your password hasn't changed.`,
    },
  });
}

/**
 * Confirm an address.
 *
 * Deliberately not a gate: nothing refuses to work until this is clicked. Signup
 * abuse is already rate-limited by email domain, and what this adds is the signal
 * that limiter cannot see — whether the address is real.
 */
export function sendVerifyEmail(o: { userId: string; email: string; token: string }): Promise<SendResult> {
  return send({
    kind: "verify_email",
    dedupeKey: `verify_email:${o.token.slice(0, 16)}`,
    to: o.email,
    userId: o.userId,
    subject: `Confirm your email address`,
    content: {
      preheader: "One click, so we know we can reach you.",
      heading: "Confirm your email",
      blocks: [
        { p: "Confirming lets us reach you about deploys, failed payments and anything going wrong with an app — the mail you'd actually want." },
        { p: "Nothing is blocked until you do. You can keep deploying." },
      ],
      cta: { label: "Confirm this address", url: `${app()}/verify?token=${encodeURIComponent(o.token)}` },
    },
  });
}

/** Somebody was granted access to an app. Migrated onto the shared template. */
export function sendAccessGranted(o: { email: string; slug: string; userId?: string | null }): Promise<SendResult> {
  return send({
    kind: "access_granted",
    dedupeKey: `access_granted:${o.slug}:${o.email.toLowerCase()}`,
    to: o.email,
    userId: o.userId ?? null,
    subject: `You now have access to ${o.slug}`,
    content: {
      preheader: `${o.slug} is open to you.`,
      heading: `You have access to ${o.slug}`,
      blocks: [{ p: `You've been given access to the app "${o.slug}" on ${productName()}.` }],
      cta: { label: `Open ${o.slug}`, url: appUrl(o.slug) },
    },
  });
}

/* ------------------------------------------------------------------ billing */

/**
 * A card failed.
 *
 * Keyed on the invoice AND the attempt, because Stripe retries a failing card
 * about four times over two weeks and each retry is genuinely new information —
 * but a re-delivered webhook for the same attempt is not.
 */
export function sendPaymentFailed(o: {
  userId: string; email: string; invoiceId: string; attempt: number;
  amountDue?: string | null; nextAttempt?: Date | null; portalUrl: string;
}): Promise<SendResult> {
  const when = o.nextAttempt
    ? o.nextAttempt.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })
    : null;
  return sendOrRetry({
    kind: "payment_failed",
    dedupeKey: `payment_failed:${o.invoiceId}:${o.attempt}`,
    to: o.email,
    userId: o.userId,
    subject: when ? `Your payment didn't go through` : `Last try: your payment didn't go through`,
    content: {
      preheader: when ? `We'll try again on ${when}.` : "This was the last attempt.",
      heading: "Your card was declined",
      blocks: [
        {
          p: o.amountDue
            ? `We couldn't charge ${o.amountDue} for your ${productName()} subscription.`
            : `We couldn't charge your card for your ${productName()} subscription.`,
        },
        {
          p: when
            ? `We'll try again on ${when}. Updating your card now is the quickest way to sort it — nothing changes about your apps in the meantime.`
            : `This was the last automatic attempt, so your subscription is about to lapse. Your apps keep running, but Pro limits stop applying.`,
        },
      ],
      cta: { label: "Update payment method", url: o.portalUrl },
      footnote: "Usually this is an expired card or a bank hold, not anything you did wrong.",
    },
  });
}

/**
 * The subscription actually lapsed.
 *
 * Sent when we flip somebody back to free, and it says what that MEANS — which
 * apps go private, what the new ceilings are. Without it the product simply
 * starts refusing things and the user has to guess why.
 */
export function sendSubscriptionLapsed(o: { userId: string; email: string; portalUrl: string; subscriptionId: string }): Promise<SendResult> {
  return send({
    kind: "subscription_lapsed",
    dedupeKey: `subscription_lapsed:${o.subscriptionId}`,
    to: o.email,
    userId: o.userId,
    subject: `Your ${productName()} subscription has ended`,
    content: {
      preheader: "Your apps are still running. Here's what changed.",
      heading: `You're back on the free plan`,
      blocks: [
        { p: "Nothing has been deleted and nothing has stopped serving. What changes is the ceilings:" },
        {
          facts: [
            { key: "Apps", value: "3 (existing apps keep running)" },
            { key: "Public apps", value: "1" },
            { key: "Builds", value: "30 a month" },
            { key: "Auto-fix", value: "not included — you still get a paste-ready fix prompt" },
            { key: "Badge", value: `apps show a "Runs on ${productName()}" badge again` },
          ],
        },
        { p: "Resubscribing puts everything back exactly as it was." },
      ],
      cta: { label: "Resubscribe", url: o.portalUrl },
    },
  });
}

/* -------------------------------------------------------------------- usage */

/**
 * Nearly out of builds.
 *
 * Once per plan-period, because a monthly ceiling resets monthly. Before this,
 * the first signal a user got was a 402 in the middle of a deploy.
 */
export function sendApproachingLimit(o: {
  userId: string; email: string; used: number; limit: number; resetsOn: string;
}): Promise<SendResult> {
  return send({
    kind: "approaching_limit",
    dedupeKey: `approaching_limit:builds:${o.userId}:${period()}`,
    to: o.email,
    userId: o.userId,
    subject: `You've used ${o.used} of ${o.limit} builds this month`,
    content: {
      preheader: `They reset on ${o.resetsOn}.`,
      heading: "You're close to this month's build limit",
      blocks: [
        { p: `You've used ${o.used} of your ${o.limit} builds. They reset on ${o.resetsOn}.` },
        { p: "Telling you now rather than refusing a deploy later, which is how you'd otherwise find out." },
      ],
      cta: { label: "See plans", url: `${app()}/settings` },
    },
  });
}

/* ------------------------------------------------------------------ runtime */

/**
 * An app is throwing errors in production.
 *
 * The highest-value email here, and the one every part of already existed:
 * log ingestion, error detection, and the fix-prompt generator. Nothing wired
 * them to a message.
 *
 * Keyed by app and hour so a genuinely broken app reports once an hour rather
 * than once per error — the alternative being a thousand emails describing the
 * same crash loop.
 */
export function sendProductionErrors(o: {
  userId: string; email: string; slug: string; count: number; sample: string; hourKey: string;
}): Promise<SendResult> {
  return send({
    kind: "production_errors",
    dedupeKey: `production_errors:${o.slug}:${o.hourKey}`,
    to: o.email,
    userId: o.userId,
    subject: `${o.slug} is throwing errors`,
    content: {
      preheader: `${o.count} error${o.count === 1 ? "" : "s"} in the last hour.`,
      heading: `${o.slug} is erroring in production`,
      blocks: [
        { p: `${o.count} error${o.count === 1 ? " was" : "s were"} logged in the last hour. The most recent one:` },
        { code: o.sample.slice(0, 1200), label: "Most recent error" },
        { p: "Open the app's Logs tab for the full picture — there's a button there that writes a fix prompt you can paste into your coding agent." },
      ],
      cta: { label: `View ${o.slug} logs`, url: `${app()}/apps/${encodeURIComponent(o.slug)}?tab=logs` },
    },
  });
}
/**
 * Somebody is asking the owner for access.
 *
 * Keyed on app + requester so a person hammering the button does not hammer the
 * owner's inbox — but NOT keyed on time, because a second ask after a denial is
 * the same ask and the owner already has it.
 */
export function sendAccessRequested(o: {
  ownerEmail: string; ownerId?: string | null; requester: string | null; slug: string;
}): Promise<SendResult> {
  const who = o.requester ?? "Someone";
  return send({
    kind: "access_requested",
    dedupeKey: `access_requested:${o.slug}:${(o.requester ?? "anon").toLowerCase()}`,
    to: o.ownerEmail,
    userId: o.ownerId ?? null,
    subject: `${who} is requesting access to ${o.slug}`,
    content: {
      preheader: `Grant or deny it from ${o.slug}'s Share settings.`,
      heading: `${who} wants access to ${o.slug}`,
      blocks: [{ p: `${who} asked for access to your app "${o.slug}". You can grant or deny it from the app's Share settings.` }],
      cta: { label: "Review the request", url: `${app()}/apps/${encodeURIComponent(o.slug)}` },
    },
  });
}
