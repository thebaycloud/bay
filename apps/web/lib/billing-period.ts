/**
 * When a usage period rolls over.
 *
 * Its own module rather than a helper inside the billing component, because it
 * is the only part of that component that can be wrong in a way nobody notices:
 * a date that renders one day early looks perfectly reasonable until somebody
 * waits for a reset that already happened.
 *
 * The trap it exists to avoid: `new Date("2026-09-01")` parses as midnight UTC,
 * and `toLocaleDateString` then renders it in the viewer's timezone — so
 * everyone west of Greenwich is told their builds reset on August 31st. The
 * period boundary is UTC (see `periodStart` in lib/usage.ts), so the formatting
 * has to be pinned to UTC too.
 */
export function nextPeriodStart(periodStart: string): Date | null {
  const [y, m] = periodStart.split("-").map(Number);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return null;
  // December rolls the year, which is the one case an off-by-one here survives
  // eleven months before anybody sees it.
  return new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));
}

/** The rollover as a human date, or a safe phrase when the period is unparseable. */
export function resetsOn(periodStart: string): string {
  const d = nextPeriodStart(periodStart);
  if (!d) return "the 1st";
  return d.toLocaleDateString(undefined, { timeZone: "UTC", month: "long", day: "numeric" });
}
