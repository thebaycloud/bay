import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleReading } from "./reading";

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
