import test from "node:test";
import assert from "node:assert/strict";
import { deriveReading, type Raw } from "@/lib/panel/reading";

/**
 * The point of these: the screen renders from PARTIAL answers now. Nine reads
 * start together and each row draws when its own lands, so `deriveReading` is
 * called with most of `Raw` missing on the first several renders and must be
 * total — every field answered, nothing thrown.
 */

test("an empty read set still produces a whole Reading", () => {
  const d = deriveReading("l3sgp", "l3sgp.supersonic.cv", {});
  assert.equal(d.slug, "l3sgp");
  assert.equal(d.an, null);
  assert.deepEqual(d.keys, []);
  assert.deepEqual(d.tables, []);
  assert.equal(d.files, 0);
  assert.equal(d.shipping, false);
  // Never an empty ships array: the row reads ships[0] unconditionally.
  assert.equal(d.ships.length, 1);
  assert.equal(d.ships[0].when, "not yet");
});

test("one read landing fills its own fields and nothing else", () => {
  const raw: Raw = { share: { visibility: "public", grants: ["a@b.com"] } };
  const d = deriveReading("l3sgp", "l3sgp.supersonic.cv", raw);
  assert.equal(d.who, "public");
  assert.deepEqual(d.people, ["a@b.com"]);
  // Analytics has not answered, and that is not the same as zero visitors.
  assert.equal(d.an, null);
});

test("a read that answers null is still an answer", () => {
  // `/_xray` resolves to null when the tenant cannot be reached. Deriving from it
  // must not throw — the row shows nothing, which is what null means.
  const d = deriveReading("l3sgp", "l3sgp.supersonic.cv", { live: null, an: {} });
  assert.deepEqual(d.live, []);
  assert.deepEqual(d.here, []);
  assert.equal(d.an, null);
});

test("a failed deploy becomes the alert, and a broken path outranks it", () => {
  const withDeploy: Raw = {
    dep: { deploy: { status: "failed", error: "migrations never ran", stage: "release" } },
  };
  assert.match(deriveReading("l3sgp", "a", withDeploy).alert?.title ?? "", /did not land/);

  // One is a change that never landed; the other is the app being broken now.
  const both: Raw = {
    ...withDeploy,
    live: { live: { paths: [{ path: "/checkout", brokenFor: 900, hits: 3, p50: 12, ago: 4 }] } },
  };
  assert.match(deriveReading("l3sgp", "a", both).alert?.title ?? "", /\/checkout has been failing/);
});
