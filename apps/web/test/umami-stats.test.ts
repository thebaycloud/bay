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
