import { test } from "node:test";
import assert from "node:assert/strict";
import { isOwnSourceObject } from "../lib/deploy-runs";

/**
 * The object name arrives from the client, and it names a path in a bucket the
 * platform keeps other things in — prebuilt code bundles and every static app's
 * published assets. So the question this guards is not "is it well formed" but
 * "did WE hand this out", and the only honest answer is the exact shape
 * `signedSourceUpload` mints and nothing else.
 */

test("accepts the shape signedSourceUpload mints", () => {
  assert.equal(isOwnSourceObject("runs/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b.tgz.enc"), true);
});

test("refuses a path that escapes the runs/ prefix", () => {
  // The one that matters: `..` is a legal object-name character in GCS, so a
  // name is not made safe by having a prefix in front of it.
  assert.equal(isOwnSourceObject("runs/../ready/other-app/bundle.tgz"), false);
  assert.equal(isOwnSourceObject("../runs/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b.tgz.enc"), false);
});

test("refuses another app's assets, however plausible", () => {
  assert.equal(isOwnSourceObject("ready/anatf/bundle.tgz"), false);
  assert.equal(isOwnSourceObject("anatf/current"), false);
});

test("refuses a name that merely contains a valid one", () => {
  // Anchoring, checked deliberately: an unanchored regex would pass both of
  // these and hand the job an arbitrary object to decrypt.
  assert.equal(isOwnSourceObject("x/runs/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b.tgz.enc"), false);
  assert.equal(isOwnSourceObject("runs/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b.tgz.enc/../../etc"), false);
});

test("refuses a uuid that is not one", () => {
  assert.equal(isOwnSourceObject("runs/not-a-uuid.tgz.enc"), false);
  assert.equal(isOwnSourceObject("runs/3F2A1B4C-5D6E-4F70-8A9B-0C1D2E3F4A5B.tgz.enc"), false);
  assert.equal(isOwnSourceObject("runs/.tgz.enc"), false);
});

test("refuses the empty string, which is what a missing header looks like", () => {
  assert.equal(isOwnSourceObject(""), false);
});
