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

/* ── one opaque slot, two facts ──────────────────────────────────────────── */

test("a return and a name share `state` without colliding", async () => {
  const { stateFor, returnPathFromCallback, nameFromCallback } = await import("../lib/github-setup");
  const at = (state: string) => new URL(`https://app.thebay.cloud/api/github/setup?state=${encodeURIComponent(state)}`);

  // The bug this separator exists for: "apps" is itself a valid slug, so the old
  // scheme — one string checked against the literal "apps" AND validated as a
  // name — sent somebody naming their app `apps` to the list with the name gone.
  const s = stateFor("apps", "apps");
  assert.equal(returnPathFromCallback(at(s)), "/");
  assert.equal(nameFromCallback(at(s)), "apps", "the name survived its own destination");
});

test("every flow lands somewhere real, and `/new` is not one of them", async () => {
  const { stateFor, returnPathFromCallback } = await import("../lib/github-setup");
  const at = (state: string) => new URL(`https://app.thebay.cloud/api/github/setup?state=${encodeURIComponent(state)}`);
  assert.equal(returnPathFromCallback(at(stateFor("apps"))), "/");
  assert.equal(returnPathFromCallback(at(stateFor("settings"))), "/settings");
  // Reconfigure cannot carry state at all — GitHub's own installation settings
  // page takes no parameters of ours — so no state must mean the app list, where
  // the dialog reopens. It used to mean `/new`, the standalone page.
  assert.equal(returnPathFromCallback(new URL("https://app.thebay.cloud/api/github/setup")), "/");
});

test("a destination is an allow list, never a path from the query string", async () => {
  const { returnPathFromCallback } = await import("../lib/github-setup");
  // `state` crosses a third party and comes back. Appending it to our own origin
  // is an open redirect, and no amount of validating a path is as safe as not
  // having one.
  for (const evil of [
    "//evil.com~", "https://evil.com~", "/../../etc~", "..%2f..~", "/new~", "javascript:alert(1)~",
  ]) {
    const u = new URL(`https://app.thebay.cloud/api/github/setup?state=${encodeURIComponent(evil)}`);
    assert.ok(["/", "/settings"].includes(returnPathFromCallback(u)), `${evil} escaped the allow list`);
  }
});

test("a name that is not a name is no name", async () => {
  const { nameFromCallback } = await import("../lib/github-setup");
  const at = (state: string) => new URL(`https://app.thebay.cloud/api/github/setup?state=${encodeURIComponent(state)}`);
  assert.equal(nameFromCallback(at("apps~My App")), "");
  assert.equal(nameFromCallback(at("apps~<script>")), "");
  assert.equal(nameFromCallback(at("apps~")), "");
  assert.equal(nameFromCallback(at("apps~ok-name-2")), "ok-name-2");
});

test("a link minted before the separator existed still works", async () => {
  const { returnPathFromCallback, nameFromCallback } = await import("../lib/github-setup");
  // Somebody has this page open in a tab right now. Their install URL carries a
  // bare slug, and it has to keep meaning what it meant.
  const u = new URL("https://app.thebay.cloud/api/github/setup?state=my-old-app");
  assert.equal(nameFromCallback(u), "my-old-app");
  assert.equal(returnPathFromCallback(u), "/", "and lands on the app list rather than nowhere");
});

test("stateFor refuses to smuggle a bad name into the slot", async () => {
  const { stateFor } = await import("../lib/github-setup");
  assert.equal(stateFor("apps", "not a slug"), "apps~");
  assert.equal(stateFor("apps", "fine-name"), "apps~fine-name");
});
