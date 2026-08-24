import test from "node:test";
import assert from "node:assert/strict";
import { returnPathFromCallback } from "@/lib/github-setup";

const at = (qs: string) => new URL(`https://app.thebay.cloud/api/github/setup${qs}`);

test("the app list asks for the app list", () => {
  assert.equal(returnPathFromCallback(at("?installation_id=1&state=apps")), "/");
});

test("everything else lands on /new, which is where it always landed", () => {
  assert.equal(returnPathFromCallback(at("?installation_id=1")), "/new");
  assert.equal(returnPathFromCallback(at("?installation_id=1&state=new")), "/new");
});

test("a state we did not write is not a destination", () => {
  // This value left our origin and came back through GitHub. Treating it as a
  // path is an open redirect, which is the whole reason this is an allow-list of
  // two and not a string that gets appended to an origin.
  for (const bad of [
    "?state=https://evil.example",
    "?state=//evil.example",
    "?state=/../admin",
    "?state=%2F%2Fevil.example",
    "?state=",
  ]) {
    assert.equal(returnPathFromCallback(at(bad)), "/new", bad);
  }
});
