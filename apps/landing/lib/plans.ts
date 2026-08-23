import { APP_URL, BRAND, CONTACT_EMAIL } from "./brand";

/**
 * The plans, as data.
 *
 * Lives here rather than in the pricing page so the numbers have one home: they
 * are also the thing `entitlements.ts` enforces, and a price on a page that
 * disagrees with the limit in the code is the worst kind of drift.
 */
export const PLANS = [
  {
    name: "Free",
    price: "$0",
    unit: "forever",
    desc: "Three real apps with a database, an address, and everyone you share them with.",
    rows: [
      "3 apps",
      "Database and storage included",
      "Share with anyone by email",
      "One public app",
    ],
    cta: "Start free",
    href: `${APP_URL}/new`,
    fill: false,
  },
  {
    name: "Pro",
    price: "$20",
    unit: "per month",
    desc: "Unlimited apps, a domain of your own, and failed deploys that repair themselves.",
    rows: [
      "Everything in Free, unlimited",
      "Your own domain",
      "Auto-fix every failed build",
      `No ${BRAND} badge`,
      "Backups and undo",
    ],
    cta: "Go Pro",
    href: `${APP_URL}/new`,
    fill: true,
  },
  {
    name: "Team",
    price: "Let's talk",
    unit: "",
    desc: "For a team whose internal tools all live in one place. You pay for the people who build, never for the people who use.",
    rows: [
      "Everything in Pro",
      "Sign in with your company domain",
      "Roles and an audit log",
      "Unlimited recipients, always free",
    ],
    cta: "Talk to us",
    href: `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`${BRAND} Team plan`)}`,
    fill: false,
  },
];
