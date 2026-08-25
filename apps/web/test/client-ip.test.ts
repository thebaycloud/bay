import { test } from "node:test";
import assert from "node:assert/strict";
import { clientIp, TRUSTED_FROM_END } from "@/lib/client-ip";

/**
 * Which forwarded address may be used as a rate-limit key.
 *
 * These tests pin the MECHANISM — that the trusted position is counted from the
 * end of the list and that a client-supplied prefix cannot become the key. They
 * do not pin the OFFSET, which is still unmeasured; see the note on
 * TRUSTED_FROM_END in lib/client-ip.ts and task 3 of
 * docs/superpowers/plans/2026-08-25-rate-limiting.md.
 *
 * The distinction matters. The mechanism is what makes forging useless and it
 * can be asserted here. The offset is a fact about Cloud Run's frontend, it
 * cannot be learned from a unit test, and asserting a guessed value here would
 * turn an open question into a green check.
 */

function req(xff?: string): Request {
  return new Request("https://app.thebay.cloud/api/signup", {
    headers: xff === undefined ? {} : { "x-forwarded-for": xff },
  });
}

test("a single address is that address", () => {
  assert.equal(clientIp(req("203.0.113.4")), "203.0.113.4");
});

test("a forged leading entry does not become the key", () => {
  // The whole reason this module exists. Taking the FIRST element — which is
  // what nearly every example on the internet does — returns a value the caller
  // chose. A fresh fake address per request is a fresh bucket per request, so
  // no ceiling is ever reached and the limiter reports green while stopping
  // nobody.
  const got = clientIp(req("203.0.113.9, 198.51.100.7"));
  assert.notEqual(got, "203.0.113.9");
  assert.equal(got, "198.51.100.7");
});

test("a long forged prefix changes nothing", () => {
  const got = clientIp(req("1.1.1.1, 2.2.2.2, 3.3.3.3, 198.51.100.7"));
  assert.equal(got, "198.51.100.7");
});

test("whitespace around entries is not part of the key", () => {
  // Two buckets for one address would halve the ceiling in the worst case and
  // do it invisibly.
  assert.equal(clientIp(req("  198.51.100.7  ")), "198.51.100.7");
  assert.equal(clientIp(req("1.1.1.1,198.51.100.7")), "198.51.100.7");
});

test("no header at all is null, not a shared bucket", () => {
  // Returning a constant like "unknown" would put every header-less request in
  // one bucket, so a handful of them would lock out all the others. Null means
  // the caller decides, and the callers here skip the address key rather than
  // inventing one.
  assert.equal(clientIp(req()), null);
});

test("an empty or comma-only header is null, not an empty-string bucket", () => {
  assert.equal(clientIp(req("")), null);
  assert.equal(clientIp(req(" , , ")), null);
});

test("the trusted offset is still the unmeasured one", () => {
  // A tripwire, not a preference. TRUSTED_FROM_END is currently a default and
  // not a measurement; the day somebody runs the probe in task 3 and changes
  // it, this test fails and makes them read the comment explaining that
  // enforcement was waiting on exactly that number.
  assert.equal(TRUSTED_FROM_END, 0);
});
