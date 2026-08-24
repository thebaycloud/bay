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
  const d = deriveReading("l3sgp", "l3sgp.thebay.cloud", {});
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
  // `share` used to be one of these reads. Access moved to the workbench header,
  // which fetches it itself for the waiting-to-be-let-in badge, so the panel does
  // not ask a second time — see SharePopover.
  const raw: Raw = { env: { keys: ["DATABASE_URL", "STRIPE_SECRET"] } };
  const d = deriveReading("l3sgp", "l3sgp.thebay.cloud", raw);
  assert.deepEqual(d.keys.map((k) => k.name), ["DATABASE_URL", "STRIPE_SECRET"]);
  // Analytics has not answered, and that is not the same as zero visitors.
  assert.equal(d.an, null);
});

test("a read that answers null is still an answer", () => {
  // `/_xray` resolves to null when the tenant cannot be reached. Deriving from it
  // must not throw — the row shows nothing, which is what null means.
  const d = deriveReading("l3sgp", "l3sgp.thebay.cloud", { live: null, an: {} });
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

/* ==========================================================================
   THE ANALYTICS HALF

   Everything below is about one screen that had four numbers on it, two of
   which were wrong: `change` was hardcoded to the empty string and therefore
   always rendered "—", and the tile labelled "bounce" was fed a field called
   `returning`. The two lists the reader already fetched — pages and referrers —
   were dropped on the floor one function above the screen that wanted them.
   ========================================================================== */

const STATS = {
  range: "30d",
  visitors: 10,
  views: 179,
  visits: 35,
  bounces: 16,
  totalTime: 19970,
  prevVisitors: 4,
  prevViews: 100,
  pages: [{ x: "/", y: 10 }, { x: "/v", y: 1 }],
  referrers: [{ x: "app.supersonic.cv", y: 2 }, { x: "", y: 1 }],
};

test("the analytics screen reads every number it draws", () => {
  const d = deriveReading("l3sgp", "l3sgp.supersonic.cv", {
    an: { enabled: true, provisioned: true, stats: STATS },
  } as Raw);
  assert.ok(d.an);
  assert.equal(d.an.visitors, 10);
  assert.equal(d.an.views, 179);
  // 16 bounces over 35 sessions. The number is a bounce rate and now says so.
  assert.equal(d.an.bounce, "46%");
  // 10 visitors against 4 in the window before: +150%, which the tile has never
  // once shown because this field was the empty string in the source.
  assert.equal(d.an.dv, "+150%");
  assert.equal(d.an.dvUp, true);
  assert.deepEqual(d.an.pages, [["/", 10], ["/v", 1]]);
  // A referrer with no name is a direct visit, which is most of them for an app
  // somebody shared as a link — dropping it would put the largest answer to
  // "where did they come from" nowhere on the screen.
  assert.deepEqual(d.an.from, [["app.supersonic.cv", 2], ["direct", 1]]);
});

test("a fall is a fall, and no previous window is no percentage at all", () => {
  const down = deriveReading("x", "x.dev", {
    an: { enabled: true, provisioned: true, stats: { ...STATS, visitors: 2, prevVisitors: 8 } },
  } as Raw);
  assert.equal(down.an?.dv, "-75%");
  assert.equal(down.an?.dvUp, false);

  const fresh = deriveReading("x", "x.dev", {
    an: { enabled: true, provisioned: true, stats: { ...STATS, prevVisitors: 0 } },
  } as Raw);
  // Percent change from zero is infinity. "" renders as "—", which is the only
  // honest thing to draw in a box that small.
  assert.equal(fresh.an?.dv, "");
});

test("a list umami refused is empty here, and the screen says so through `an`", () => {
  const d = deriveReading("x", "x.dev", {
    an: { enabled: true, provisioned: true, stats: { ...STATS, pages: null, referrers: null } },
  } as Raw);
  assert.deepEqual(d.an?.pages, []);
  assert.deepEqual(d.an?.from, []);
  // The headline numbers are still true, and are still drawn. A missing column
  // beside a real visitor count is a worse reading, not an unreadable one.
  assert.equal(d.an?.visitors, 10);
});

test("off and unprovisioned are told apart, and neither is zero visitors", () => {
  const off = deriveReading("x", "x.dev", { an: { enabled: false, provisioned: true, stats: null } } as Raw);
  assert.equal(off.an, null);
  assert.equal(off.anOn, false);
  assert.equal(off.anReady, true);

  const unready = deriveReading("x", "x.dev", { an: { enabled: true, provisioned: false, stats: null } } as Raw);
  assert.equal(unready.anOn, true);
  assert.equal(unready.anReady, false);
});
