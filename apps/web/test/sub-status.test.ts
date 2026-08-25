import { test } from "node:test";
import assert from "node:assert/strict";
import { mapStatus } from "../lib/stripe";

/**
 * Which Stripe statuses still get paid perks.
 *
 * `entitlement()` grants every paid limit to any status that is not 'canceled',
 * and justifies it in a comment: past_due is grace because Stripe is still
 * retrying the card. `mapStatus` used to fold 'unpaid' in with 'past_due' — and
 * 'unpaid' is the opposite case, the state Stripe moves a subscription to once
 * dunning is finished and it has given up. So a customer whose card finally
 * failed kept unlimited apps, 500 builds and 100 agent runs a month, forever,
 * from the moment we established we were never getting paid.
 *
 * The two names read alike, which is the whole problem, so the rule is pinned
 * here rather than left to whoever edits the switch next.
 */
test("only past_due is grace — unpaid is not", () => {
  assert.equal(mapStatus("past_due"), "past_due", "past_due is a card being retried");
  assert.equal(mapStatus("unpaid"), "canceled", "unpaid is dunning OVER — it must not keep paid perks");
});

test("active and trialing are usable", () => {
  assert.equal(mapStatus("active"), "active");
  assert.equal(mapStatus("trialing"), "active", "a trial can use what it is trialling");
});

test("everything else locks, including statuses Stripe has not invented yet", () => {
  for (const s of ["canceled", "incomplete", "incomplete_expired", "paused", "", "something_new"]) {
    assert.equal(mapStatus(s), "canceled", `${s || "(empty)"} must not grant paid perks`);
  }
});
