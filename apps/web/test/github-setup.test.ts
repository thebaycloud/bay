import { test } from "node:test";
import assert from "node:assert/strict";
import { installationFromCallback, nameFromCallback } from "../lib/github-setup";

/**
 * The callback's decision, kept out of the route so it can be read without a
 * request, a session or a database — and because a Next route file may export
 * nothing but its handlers.
 *
 * What is worth asserting is that a missing or junk `installation_id` is a
 * refusal rather than a row. `Number("")` is 0 and `Number("abc")` is NaN, and
 * both of those reaching a bigint parameter is either a database round trip
 * that cannot match or an error from the driver.
 */

test("a well-formed callback yields the installation to record", () => {
  const d = installationFromCallback(
    new URL("https://app.supersonic.cv/api/github/setup?installation_id=155650459&setup_action=install"),
  );
  assert.deepEqual(d, { ok: true, installationId: 155650459 });
});

test("a missing installation_id is refused", () => {
  const d = installationFromCallback(new URL("https://app.supersonic.cv/api/github/setup"));
  assert.deepEqual(d, { ok: false, reason: "no-installation" });
});

test("a junk installation_id is refused rather than coerced", () => {
  for (const raw of ["abc", "-1", "0", "1.5", "", " ", "1e9", "0x10", "9007199254740993"]) {
    const d = installationFromCallback(
      new URL(`https://x/api/github/setup?installation_id=${encodeURIComponent(raw)}`),
    );
    assert.equal(d.ok, false, `accepted ${JSON.stringify(raw)}`);
  }
});

test("setup_action does not change the outcome", () => {
  // GitHub sends `install` on a first install and `update` when the repository
  // selection changes. Both mean the same thing to us: this installation is now
  // this workspace's, with whatever it can currently see.
  assert.deepEqual(
    installationFromCallback(new URL("https://x/api/github/setup?installation_id=7&setup_action=update")),
    { ok: true, installationId: 7 },
  );
  assert.deepEqual(
    installationFromCallback(new URL("https://x/api/github/setup?installation_id=7")),
    { ok: true, installationId: 7 },
  );
});

test("the name typed before the trip to GitHub survives it", async () => {
  assert.equal(nameFromCallback(new URL("https://x/cb?state=harbor-412")), "harbor-412");
});

test("anything that is not a name comes back as no name at all", async () => {
  // `state` is a string that left our origin and returned through a third
  // party, and it lands in a query string on a page we render. The regexp is
  // the whole defence: what is not a Cloud Run name is not a name.
  for (const bad of ["", "  ", "Harbor", "a b", "-lead", "x/y", "<script>", "a".repeat(40)]) {
    assert.equal(nameFromCallback(new URL(`https://x/cb?state=${encodeURIComponent(bad)}`)), "", bad);
  }
  assert.equal(nameFromCallback(new URL("https://x/cb")), "");
});
