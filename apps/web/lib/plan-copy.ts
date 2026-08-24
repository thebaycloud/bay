import type { Limits } from "./entitlements";
import { rootDomain } from "./roots";

/**
 * What a user is told when a plan limit stops them.
 *
 * Its own module because every one of these sentences is written twice
 * otherwise — /api/deploy and /api/deploy/reserve enforce the same caps at
 * different moments, and the CLI shows whichever fires first. Two copies drift,
 * and the drift is invisible until someone reports being told two different
 * things about the same refusal.
 *
 * They all read as an offer rather than a denial. A limit reached on the free
 * plan is the most positive signal we get from a user — they deployed three
 * apps and want a fourth — and "you have hit your limit" is a strange way to
 * answer good news.
 */
const APP = "app.supersonic.cv";

export function appLimitMessage(limits: Limits): string {
  const n = limits.maxApps;
  return `You're using all ${n} of your free apps. Pro is $20/month for unlimited apps — upgrade at ${APP}.`;
}

export function publicLimitMessage(limits: Limits): string {
  const n = limits.maxPublicApps;
  return n === 1
    ? `Free includes 1 public app. Your other apps can still be shared by email with as many people as you like — or upgrade at ${APP} to make them all public.`
    : `Free includes ${n} public apps. Sharing by email stays unlimited — or upgrade at ${APP}.`;
}

export function buildLimitMessage(limits: Limits): string {
  // "deploys", not "builds". The meter is incremented once per DEPLOY dispatched
  // — see countIfUnder in /api/deploy — and a refusal that names a unit the
  // dashboard does not show is a refusal somebody cannot check.
  return `You've used all ${limits.monthlyBuilds} deploys this month. They reset on the 1st — or upgrade at ${APP} for ${limits.monthlyBuilds >= 500 ? "more" : "500 a month"}.`;
}

export function agentLimitMessage(): string {
  return `You've used this month's auto-fix runs. Here's the fix to hand your coding agent instead — auto-fix resets on the 1st.`;
}

export function customDomainMessage(): string {
  return `Custom domains are on Pro. Your app keeps its ${rootDomain()} address — upgrade at ${APP} to point your own domain at it.`;
}

/** A canceled subscription downgrades to free; nothing is ever locked outright. */
export function noAccountMessage(): string {
  return `We couldn't find your account. Sign in again at ${APP}.`;
}
