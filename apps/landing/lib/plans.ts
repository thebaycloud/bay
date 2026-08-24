import { APP_URL, BRAND, CONTACT_EMAIL } from "./brand";
import { fill, type Messages } from "./i18n";

/**
 * The plans: the numbers here, the words in the catalogues.
 *
 * The split is deliberate. A price is the thing `entitlements.ts` enforces and a
 * page that disagrees with the limit in the code is the worst kind of drift, so
 * the numerals stay in one place and are never translated. Everything a reader
 * actually reads is keyed off `id` in the message catalogue.
 */
export interface Plan {
  id: "free" | "pro" | "team";
  /** A numeral, or absent when the catalogue supplies a worded price. */
  price?: string;
  name: string;
  unit: string;
  desc: string;
  rows: readonly string[];
  cta: string;
  href: string;
  fill: boolean;
}

export function plans(t: Messages): Plan[] {
  const p = t.pricing.plans;
  return [
    {
      id: "free",
      price: "$0",
      name: p.free.name,
      unit: p.free.unit,
      desc: p.free.desc,
      rows: p.free.rows,
      cta: p.free.cta,
      href: `${APP_URL}/new`,
      fill: false,
    },
    {
      id: "pro",
      price: "$20",
      name: p.pro.name,
      unit: p.pro.unit,
      desc: p.pro.desc,
      rows: p.pro.rows.map((r) => fill(r, { brand: BRAND })),
      cta: p.pro.cta,
      href: `${APP_URL}/new`,
      fill: true,
    },
    {
      id: "team",
      // Worded, not a numeral, and it comes from the catalogue.
      price: p.team.price,
      name: p.team.name,
      unit: p.team.unit,
      desc: p.team.desc,
      rows: p.team.rows,
      cta: p.team.cta,
      href: `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`${BRAND} ${p.team.name}`)}`,
      fill: false,
    },
  ];
}
