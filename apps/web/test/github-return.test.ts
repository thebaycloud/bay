import test from "node:test";
import assert from "node:assert/strict";
import { returnPathFromCallback } from "@/lib/github-setup";

const at = (qs: string) => new URL(`https://app.thebay.cloud/api/github/setup${qs}`);

test("the app list asks for the app list", () => {
  assert.equal(returnPathFromCallback(at("?installation_id=1&state=apps~")), "/");
});

test("everything else lands on the app list too, where the dialog reopens", () => {
  // This asserted `/new` and was right about the behaviour at the time. It was
  // also the bug: only the Connect button inside the dialog sent a state, so
  // Reconfigure, Add an account and both links in Settings fell through to the
  // standalone page — which cannot reopen anything and makes a person start over.
  //
  // Reconfigure in particular CANNOT send a state: it goes to GitHub's own
  // installation settings page, which takes no parameters of ours. So the
  // default is not a fallback here, it is the main path.
  assert.equal(returnPathFromCallback(at("?installation_id=1")), "/");
  assert.equal(returnPathFromCallback(at("?installation_id=1&state=settings~")), "/settings");
});

test("a state we did not write is not a destination", () => {
  // This value left our origin and came back through GitHub. Treating it as a
  // path is an open redirect, which is the whole reason this is an allow-list and
  // not a string that gets appended to an origin. Two keys today; the count is
  // not the property, the closed set is.
  for (const bad of [
    "?state=https://evil.example",
    "?state=//evil.example",
    "?state=/../admin",
    "?state=%2F%2Fevil.example",
    "?state=",
  ]) {
    assert.ok(["/", "/settings"].includes(returnPathFromCallback(at(bad))), bad);
  }
});
