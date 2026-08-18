import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleReading } from "./reading";
import { decideEdge } from "./edge";

const deps = {
  xray: () => ({ since: 1000, here: { count: 2, names: ["ada", "grace"] }, paths: [], dropped: 0 }),
  listBuilds: async () => [
    { runId: "r1", who: "agent" as const, startedAt: 500, endedAt: 900, outcome: "ok" as const, linesGone: true },
  ],
  door: async () => ({ door: "lilna.supersonic.cv", open: true }),
};

test("the reading carries two windows, because its halves have two lifetimes", async () => {
  // here/paths die with a proxy release; builds are durable. One `since` over
  // both would lie about one of them — and an empty live half after a release is
  // not an app with no traffic.
  const r = await assembleReading("lilna", deps);
  assert.equal(r.since.live, 1000);
  assert.equal(r.since.builds, "durable");
});

test("who did it survives into the reading", async () => {
  const r = await assembleReading("lilna", deps);
  assert.equal(r.builds[0].who, "agent");
  assert.equal(r.builds[0].linesGone, true);
});

test("a durable half that could not be read says so, rather than saying nothing happened", async () => {
  // The failure mode this exists to stop: Postgres is down, the build list comes
  // back empty, and the reading is indistinguishable from an app that has never
  // been built. Both a person and an agent would read that as "nothing ever
  // happened" — which is exactly what `since` is carried to prevent.
  const outage = { ...deps, listBuilds: async () => null };
  const r = await assembleReading("lilna", outage);
  assert.equal(r.since.builds, "unreadable");
  assert.deepEqual(r.builds, []);
});

test("an app with no builds is durable and empty, not unreadable", async () => {
  // The other side of the same coin: a real empty answer must keep saying it is
  // a real answer, or the honest degradation swallows the honest fact.
  const r = await assembleReading("new", { ...deps, listBuilds: async () => [] });
  assert.equal(r.since.builds, "durable");
  assert.deepEqual(r.builds, []);
});

test("a reading is produced even when every source is empty", async () => {
  // An app that has never come up must still have a reading; the page and the
  // agent both need something with the right shape to render "nothing yet".
  const empty = {
    xray: () => ({ since: 42, here: { count: 0, names: [] }, paths: [], dropped: 0 }),
    listBuilds: async () => [],
    door: async () => ({ door: "new.supersonic.cv", open: false }),
  };
  const r = await assembleReading("new", empty);
  assert.equal(r.open, false);
  assert.deepEqual(r.builds, []);
  assert.equal(r.live.here.count, 0);
});

test("an app that has never come up answers with a reading, not with the room page", async () => {
  // The state the reading could not be fetched in. `/_xray` used to be decided
  // after the edge, and the edge answers for an app with no run_url with the
  // room — as HTML, with a 200, whatever the request asked for. An agent
  // polling https://new-app.supersonic.cv/_xray during a first deploy called
  // r.json() on that page and threw.
  const mid = {
    buildLive: false, status: "deploying" as const,
    deploy: { status: "building", error: null, updatedAt: Date.now() },
    now: Date.now(),
  };
  // Same app, same moment: a visitor still gets the room, and only the owner
  // asking for /_xray gets the reading.
  assert.deepEqual(decideEdge(mid), { page: "building" });
  assert.deepEqual(decideEdge({ ...mid, xrayForOwner: true }), { serve: "xray" });

  // And that reading says the app is not open, which no served reading could
  // say while the edge answered first.
  const r = await assembleReading("new", {
    xray: () => ({ since: 42, here: { count: 0, names: [] }, paths: [], dropped: 0 }),
    listBuilds: async () => [],
    door: async () => ({ door: "new.supersonic.cv", open: false }),
  });
  assert.equal(r.open, false);
});

/**
 * The gaps in a time series are the reading.
 *
 * Umami returns only the buckets that had traffic. Drawn straight, five busy
 * hours out of twenty-four become five columns side by side — a chart whose x
 * axis is not time, under a caption promising each column is one hour. An app
 * nobody visited between three and eleven should look like it.
 */
test("quiet hours are put back into the series", async () => {
  process.env.AUTH_SECRET ??= "test-only-config-secret-do-not-log";
  const { __test } = await import("./analytics");
  const zip = __test.zipSeries;
  const at = (h: number) => `2026-08-18 ${String(h).padStart(2, "0")}:00:00`;
  const series = zip({ pageviews: [{ x: at(1), y: 5 }, { x: at(4), y: 2 }], sessions: [{ x: at(1), y: 3 }] }, "hour");
  assert.deepEqual(series.map((p) => p.views), [5, 0, 0, 2], "the two silent hours are drawn as silence");
  assert.equal(series[0].sessions, 3);
  assert.equal(series[1].sessions, 0);

  // Months are not a fixed number of milliseconds, so they are left alone.
  const months = zip({ pageviews: [{ x: "2026-01-01 00:00:00", y: 1 }, { x: "2026-04-01 00:00:00", y: 2 }] }, "month");
  assert.equal(months.length, 2);
});
