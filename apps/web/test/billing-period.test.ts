import { test } from "node:test";
import assert from "node:assert/strict";
import { nextPeriodStart, resetsOn } from "../lib/billing-period";

/**
 * The date the billing card promises a usage reset on.
 *
 * Worth a test despite being four lines, because both ways of getting it wrong
 * are invisible in review and obvious to a user: a timezone slip renders the
 * reset a day early for everyone west of Greenwich, and a December roll that
 * forgets the year survives eleven months before anybody notices.
 */

test("rolls to the first of the next month, in UTC", () => {
  assert.equal(nextPeriodStart("2026-08-01")?.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(nextPeriodStart("2026-01-01")?.toISOString(), "2026-02-01T00:00:00.000Z");
});

test("December rolls the year", () => {
  assert.equal(nextPeriodStart("2026-12-01")?.toISOString(), "2027-01-01T00:00:00.000Z");
});

test("an unparseable period is a phrase, not a crash or an Invalid Date", () => {
  assert.equal(nextPeriodStart(""), null);
  assert.equal(nextPeriodStart("nonsense"), null);
  assert.equal(nextPeriodStart("2026-13-01"), null, "month 13 must not roll silently");
  assert.equal(resetsOn(""), "the 1st");
});

test("the rendered date is pinned to UTC", () => {
  // The actual bug this guards: formatting the UTC instant in a western
  // timezone yields the last day of the PREVIOUS month, so a person is told
  // their builds reset on the 31st when they reset on the 1st.
  const tz = process.env.TZ;
  try {
    process.env.TZ = "America/Los_Angeles";
    const rendered = resetsOn("2026-08-01");
    assert.match(rendered, /1/, `expected the 1st, got "${rendered}"`);
    assert.doesNotMatch(rendered, /31/, `rendered in local time: "${rendered}"`);
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});
