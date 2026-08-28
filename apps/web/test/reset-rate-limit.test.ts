import { test } from "node:test";
import assert from "node:assert/strict";
import { CEILINGS, type Scope } from "../lib/rate-limit";

/**
 * The reset endpoint cannot be unbounded, whatever the global mode says.
 *
 * `RATE_LIMIT_MODE` defaults to `off` and was unset in production, which is a
 * defensible resting state for the limiters that guard OUR resources — a signup
 * farm costs us rows, and the file is explicit that guessed ceilings should be
 * counted before they are allowed to refuse anybody.
 *
 * Password reset is not that. It mails an address the CALLER chooses, so with no
 * ceiling it is a way to mail-bomb a stranger from our domain — and sending
 * reputation is shared across every email here, so the damage lands on everybody
 * else's password reset. `always` is the flag that keeps it bounded; this test is
 * what stops the flag being dropped in a tidy-up, because nothing about the
 * behaviour is visible until it is abused.
 */

const MUST_ALWAYS_HOLD: Scope[] = ["reset:email", "reset:ip"];

test("the reset ceilings hold even with the limiter switched off", () => {
  for (const scope of MUST_ALWAYS_HOLD) {
    assert.equal(
      CEILINGS[scope].always,
      true,
      `${scope} is skipped when RATE_LIMIT_MODE is off — /forgot becomes an open mail relay`,
    );
  }
});

test("the reset ceilings are small enough to matter and large enough to be usable", () => {
  // Somebody who deleted the first email and asked again must not be refused, so
  // the floor is above 1. And a ceiling in the hundreds is not a ceiling.
  const perAddress = CEILINGS["reset:email"];
  assert.ok(perAddress.limit >= 2, "one attempt per hour refuses a legitimate second ask");
  assert.ok(perAddress.limit <= 5, `${perAddress.limit} reset emails an hour to one address is a mail bomb`);
  assert.equal(perAddress.windowSec, 3600);
});

test("reset fails OPEN, unlike login", () => {
  // The asymmetry is the point, and it is the opposite of login's. Failing closed
  // during a database blip means nobody can recover an account for as long as it
  // lasts, and there is no other way in — while being wrong the other way costs a
  // few duplicate emails.
  for (const scope of MUST_ALWAYS_HOLD) {
    assert.equal(CEILINGS[scope].failClosed, false, `${scope} must not lock people out of recovery during an outage`);
  }
  assert.equal(CEILINGS["login:email-ip"].failClosed, true, "login must still fail closed");
});
