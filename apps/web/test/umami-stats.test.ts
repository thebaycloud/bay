import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

/**
 * What umami actually answers, and what this module made of it.
 *
 * The bug these exist for: `/stats` came back FLAT — `{"pageviews":179,
 * "visitors":10}` — and the reader asked for `m.value`, which on a number is
 * `undefined`. Every figure became 0, so the panel drew a confident "0 visitors"
 * over an app with ten. A read that succeeds and means nothing is worse than a
 * read that fails, because nothing downstream can tell.
 *
 * Env before import: the module reads UMAMI_URL and UMAMI_PASSWORD at module
 * scope, and a hostname that is not *.run.app is what keeps `invoker()` from
 * reaching for a Google identity token that no test has.
 */
process.env.UMAMI_URL = "http://umami.test";
process.env.UMAMI_PASSWORD = "hunter2";
process.env.UMAMI_USER = "admin";

/**
 * Imported lazily, and inside a test rather than at the top: the file is
 * transformed to CJS by tsx, which has no top-level await, and the module has to
 * be loaded AFTER the variables above are set because it reads them at module
 * scope.
 */
type Umami = typeof import("../lib/umami");
let mod: Umami | null = null;
async function lib(): Promise<Umami> {
  mod ??= await import("../lib/umami");
  return mod;
}

type Answer = { status?: number; body: unknown };
let routes: Record<string, Answer>;
let asked: string[];

/** Every call the module makes, answered from a table and recorded. */
function stubFetch() {
  asked = [];
  (globalThis as { fetch: unknown }).fetch = async (url: string | URL, init?: { method?: string }) => {
    const u = String(url);
    asked.push(`${init?.method ?? "GET"} ${u.replace("http://umami.test", "")}`);
    if (u.includes("/api/auth/login")) {
      return new Response(JSON.stringify({ token: "jwt" }), { status: 200 });
    }
    for (const [frag, a] of Object.entries(routes)) {
      if (u.includes(frag)) {
        return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
      }
    }
    return new Response("{}", { status: 404 });
  };
}

beforeEach(() => {
  routes = {};
  stubFetch();
});

const FLAT = {
  pageviews: 179,
  visitors: 10,
  visits: 35,
  bounces: 16,
  totaltime: 19970,
  comparison: { pageviews: 100, visitors: 4 },
};

test("the flat shape — the one running in production — is read, not zeroed", async () => {
  routes = {
    "/stats?": { body: FLAT },
    "type=path": { body: [{ x: "/", y: 10 }] },
    "type=referrer": { body: [] },
  };
  const { websiteStats } = await lib();
  const s = await websiteStats("w1", "30d");
  assert.ok(s);
  assert.equal(s.visitors, 10);
  assert.equal(s.views, 179);
  assert.equal(s.visits, 35);
  assert.equal(s.bounces, 16);
  // The previous window is a SIBLING object in this shape, not a `prev` field.
  assert.equal(s.prevVisitors, 4);
  assert.equal(s.prevViews, 100);
});

test("the paired shape is read the same way", async () => {
  routes = {
    "/stats?": { body: { pageviews: { value: 179, prev: 100 }, visitors: { value: 10, prev: 4 } } },
    "type=": { body: [] },
  };
  const { websiteStats } = await lib();
  const s = await websiteStats("w1");
  assert.ok(s);
  assert.equal(s.visitors, 10);
  assert.equal(s.views, 179);
  assert.equal(s.prevVisitors, 4);
});

test("the delta shape reports the change, so the previous window is value minus it", async () => {
  routes = {
    "/stats?": { body: { pageviews: { value: 179, change: 79 }, visitors: { value: 10, change: 6 } } },
    "type=": { body: [] },
  };
  const { websiteStats } = await lib();
  const s = await websiteStats("w1");
  assert.ok(s);
  assert.equal(s.prevVisitors, 4);
  assert.equal(s.prevViews, 100);
});

test("`uniques` is read when this build has no `visitors`", async () => {
  routes = { "/stats?": { body: { pageviews: 5, uniques: 3, comparison: { uniques: 1 } } }, "type=": { body: [] } };
  const { websiteStats } = await lib();
  const s = await websiteStats("w1");
  assert.equal(s?.visitors, 3);
  assert.equal(s?.prevVisitors, 1);
});

test("pages fall back from `path` to `url`, because the name changed under us", async () => {
  routes = {
    "/stats?": { body: FLAT },
    "type=path": { status: 400, body: { error: "Bad request" } },
    "type=url": { body: [{ x: "/", y: 3 }] },
    "type=referrer": { body: [] },
  };
  const { websiteStats } = await lib();
  const s = await websiteStats("w1");
  assert.deepEqual(s?.pages, [{ x: "/", y: 3 }]);
  assert.ok(asked.some((a) => a.includes("type=path")), "path is tried first");
  assert.ok(asked.some((a) => a.includes("type=url")), "url is tried after the refusal");
});

test("a refused list is null, and an empty one is empty — they are not the same answer", async () => {
  routes = {
    "/stats?": { body: FLAT },
    "type=path": { status: 500, body: {} },
    "type=url": { status: 400, body: {} },
    "type=referrer": { body: [] },
  };
  const { websiteStats } = await lib();
  const s = await websiteStats("w1");
  // THE BUG THIS FILE IS NAMED FOR. `[]` here would render as "no pages", which
  // is a claim about the app; null renders as nothing, which is the truth.
  assert.equal(s?.pages, null);
  assert.deepEqual(s?.referrers, []);
});

test("a refused /stats is null overall — never a row of zeroes", async () => {
  routes = { "/stats?": { status: 500, body: {} }, "type=": { body: [] } };
  const { websiteStats } = await lib();
  assert.equal(await websiteStats("w1"), null);
});

test("the parsers, on their own", async () => {
  const { __test } = await lib();
  assert.equal(__test.num(7), 7);
  assert.equal(__test.num({ value: 7 }), 7);
  assert.equal(__test.num(undefined), 0);
  assert.equal(__test.before(7, { visitors: 3 }, "visitors"), 3);
  assert.equal(__test.before({ value: 7, prev: 3 }, undefined, "visitors"), 3);
  assert.equal(__test.before({ value: 7, change: 4 }, undefined, "visitors"), 3);
  // No comparison offered at all is 0, which every caller reads as "nothing to
  // compare against" rather than as a previous window that was empty.
  assert.equal(__test.before(7, undefined, "visitors"), 0);
});

/* ==========================================================================
   PROVISIONING, WHICH IS THE HALF THAT DECIDES WHETHER THERE IS ANYTHING TO READ
   ========================================================================== */

test("an app that already has a site under the OLD root does not get a second one", async () => {
  const { ensureWebsite } = await lib();
  routes = {
    "/api/websites?": {
      body: { data: [{ id: "w-old", name: "l3sgp", domain: "l3sgp.supersonic.cv" }] },
    },
  };
  const id = await ensureWebsite("l3sgp");
  assert.equal(id, "w-old");
  // THE FAILURE THIS PREVENTS: a POST here mints a second site for the same app,
  // the panel reads the empty new one, and the visitors go on arriving in the
  // old one. Nothing anywhere says so.
  assert.ok(!asked.some((a) => a.startsWith("POST /api/websites")), "no site was created");
});

test("an app with no site anywhere gets one, under the canonical root", async () => {
  const { ensureWebsite } = await lib();
  routes = {
    "/api/websites?": { body: { data: [] } },
    "/api/websites": { body: { id: "w-new" } },
  };
  assert.equal(await ensureWebsite("qjl80"), "w-new");
  assert.ok(asked.some((a) => a.startsWith("POST /api/websites")));
});

test("umami not answering the list creates nothing at all", async () => {
  const { ensureWebsite } = await lib();
  routes = { "/api/websites?": { status: 500, body: {} } };
  assert.equal(await ensureWebsite("qjl80"), null);
  // "Could not ask" must never become "does not exist" — that is how one
  // unreachable minute turns into a duplicate site per deploy.
  assert.ok(!asked.some((a) => a.startsWith("POST /api/websites")));
});

/* ==========================================================================
   THE FULL READ — every dimension, the series, who is here now
   ========================================================================== */

test("the series is keyed by time, not by index — umami omits its empty buckets", async () => {
  const { __test } = await lib();
  // Umami answers pageviews and sessions as separate arrays and drops the
  // buckets with nothing in them, INDEPENDENTLY. Zipped by index, this pairs
  // the 17th's views with the 16th's visitors the moment one array skips a day.
  const day = 86_400_000;
  const t0 = Date.UTC(2026, 7, 16);
  const points = __test.zip(
    [{ x: "2026-08-16T00:00:00Z", y: 4 }, { x: "2026-08-18T00:00:00Z", y: 37 }],
    [{ x: "2026-08-18T00:00:00Z", y: 3 }],
    t0,
    t0 + 2 * day,
    "day",
  );
  assert.deepEqual(points, [
    { t: t0, views: 4, visitors: 0 },
    { t: t0 + day, views: 0, visitors: 0 },   // the quiet day exists on the axis
    { t: t0 + 2 * day, views: 37, visitors: 3 },
  ]);
});

test("a window with nothing in it is still a window", async () => {
  const { __test } = await lib();
  const t0 = Date.UTC(2026, 7, 20, 0);
  const points = __test.zip([], undefined, t0, t0 + 3 * 3600_000, "hour");
  assert.equal(points.length, 4);
  assert.ok(points.every((p: { views: number; visitors: number }) => p.views === 0 && p.visitors === 0));
});

test("nobody here now is 0; umami not saying is null", async () => {
  const { __test } = await lib();
  assert.equal(__test.activeCount({ visitors: 3 }), 3);
  assert.equal(__test.activeCount([{ x: 1 }, { x: 2 }]), 2);
  assert.equal(__test.activeCount(7), 7);
  assert.equal(__test.activeCount(null), null);
  assert.equal(__test.activeCount({ nope: 1 }), null);
});

test("the full read carries every dimension the instance answers, and omits the ones it refuses", async () => {
  const { websiteDetail } = await lib();
  routes = {
    "/stats?": { body: FLAT },
    "type=path": { body: [{ x: "/", y: 10 }, { x: "/v", y: 1 }] },
    "type=referrer": { body: [{ x: "", y: 2 }] },
    "type=country": { body: [{ x: "KZ", y: 7 }] },
    // This instance refuses `host`, and there is no second name to try.
    "type=host": { status: 400, body: {} },
    "type=": { body: [] },
    "/pageviews?": { body: { pageviews: [{ x: "2026-08-24T00:00:00Z", y: 5 }], sessions: [] } },
    "/active": { body: { visitors: 2 } },
    "/sessions?": {
      body: {
        data: [{
          id: "s1", firstAt: "2026-08-24T10:00:00Z", lastAt: "2026-08-24T10:18:00Z",
          visits: 13, views: 121, country: "KZ", city: "Astana", device: "laptop", browser: "chrome", os: "Mac OS",
        }],
      },
    },
  };
  const d = await websiteDetail("w1", "7d");
  assert.ok(d);
  assert.equal(d.visitors, 10);
  assert.equal(d.active, 2);
  assert.deepEqual(d.dims.pages, [["/", 10], ["/v", 1]]);
  // A referrer with no name is a direct visit, named rather than dropped.
  assert.deepEqual(d.dims.from, [["direct", 2]]);
  assert.deepEqual(d.dims.country, [["KZ", 7]]);
  // Absent, not empty: an empty list would be a claim about the app, and this
  // is a fact about umami.
  assert.equal("hosts" in d.dims, false);
  assert.equal(d.visitors_recent.length, 1);
  assert.equal(d.visitors_recent[0].city, "Astana");
  assert.equal(d.unit, "day");
  assert.ok(d.series.length >= 7, "a seven-day window has seven or eight buckets");
});

test("a day's window is bucketed by hour, a month's by day", async () => {
  const { websiteDetail } = await lib();
  routes = { "/stats?": { body: FLAT }, "type=": { body: [] }, "/pageviews?": { body: {} }, "/active": { body: {} }, "/sessions?": { body: { data: [] } } };
  assert.equal((await websiteDetail("w1", "1d"))?.unit, "hour");
  assert.equal((await websiteDetail("w1", "30d"))?.unit, "day");
});

test("no stats means no screen, not a screen of zeroes", async () => {
  const { websiteDetail } = await lib();
  routes = { "/stats?": { status: 503, body: {} }, "type=": { body: [] } };
  assert.equal(await websiteDetail("w1", "7d"), null);
});
