import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { record, xray, pathOf, resetXray } from "./xray";

beforeEach(() => resetXray());

test("a query string is not part of the path", () => {
  // "/search" is the thing whose cost an owner wants to see. Counting each query
  // separately would both bury that and put visitors' own words in the panel.
  assert.equal(pathOf("/search?q=someone+private"), "/search");
  assert.equal(pathOf(""), "/");
  assert.equal(pathOf("/a/" + "x".repeat(400)).length <= 121, true);
});

test("an app nobody has hit is not the same as an app we stopped watching", () => {
  // The whole failure this guards: after a proxy release the panel is empty, and
  // empty must not render as "no traffic". `since` is how a reader tells.
  const before = Date.now();
  const empty = xray("never-seen");
  assert.equal(empty.paths.length, 0);
  assert.ok(empty.since >= before, "an unseen app reports watching from now");
});

test("requests land on their path, and failures are counted apart from hits", () => {
  record("a", { url: "/api/items?page=2", status: 200, ms: 40, who: "", anonId: "c1" });
  record("a", { url: "/api/items", status: 500, ms: 90, who: "", anonId: "c1" });
  const p = xray("a").paths.find((x) => x.path === "/api/items");
  assert.equal(p?.hits, 2);
  assert.equal(p?.broke, 1);
});

test("a page that is not there is not the app breaking", () => {
  // Both were one `errors` counter, which is why every app without a favicon
  // led its own list of failures. They are different facts about different
  // people: a 404 is somebody asking for what was never there, a 500 is the app
  // failing to do its job.
  record("f", { url: "/favicon.ico", status: 404, ms: 2, who: "", anonId: "c" });
  record("f", { url: "/checkout", status: 503, ms: 30, who: "", anonId: "c" });
  const paths = xray("f").paths;
  const favicon = paths.find((x) => x.path === "/favicon.ico");
  const checkout = paths.find((x) => x.path === "/checkout");
  assert.equal(favicon?.missing, 1);
  assert.equal(favicon?.broke, 0);
  assert.equal(checkout?.broke, 1);
  assert.equal(checkout?.missing, 0);
});

test("a failure remembers when it happened", () => {
  // A count alone cannot answer the only question worth asking about a break —
  // is it happening NOW. Without this, a path that failed this morning and has
  // been healthy since still reads as the app's worst problem until the proxy
  // restarts.
  record("g", { url: "/pay", status: 500, ms: 10, who: "", anonId: "c" });
  const p = xray("g").paths.find((x) => x.path === "/pay");
  assert.ok(p?.brokeAgo !== null && p!.brokeAgo! < 5, "the last failure has an age");
  assert.ok(p?.brokenFor !== null, "a path whose last request failed is broken now");
});

test("a path that recovered is not still broken", () => {
  record("h", { url: "/pay", status: 500, ms: 10, who: "", anonId: "c" });
  record("h", { url: "/pay", status: 200, ms: 10, who: "", anonId: "c" });
  const p = xray("h").paths.find((x) => x.path === "/pay");
  // It DID break, and that stays true and visible.
  assert.equal(p?.broke, 1);
  assert.ok(p?.brokeAgo !== null, "when it broke is still known");
  // It is not breaking now, and nothing may say otherwise.
  assert.equal(p?.brokenFor, null);
});

test("a path that never failed says so with null, not with zero", () => {
  // Zero seconds ago would read as "it just broke".
  record("i", { url: "/", status: 200, ms: 10, who: "", anonId: "c" });
  const p = xray("i").paths.find((x) => x.path === "/");
  assert.equal(p?.brokeAgo, null);
  assert.equal(p?.brokenFor, null);
});

test("a page missing does not clear a break, and does not start one", () => {
  // A 404 in the middle of an outage is not the app recovering, and a 404 on a
  // healthy app is not the app failing.
  record("j", { url: "/pay", status: 500, ms: 10, who: "", anonId: "c" });
  record("j", { url: "/pay", status: 404, ms: 1, who: "", anonId: "c" });
  assert.ok(xray("j").paths.find((x) => x.path === "/pay")?.brokenFor !== null);

  record("k", { url: "/none", status: 404, ms: 1, who: "", anonId: "c" });
  assert.equal(xray("k").paths.find((x) => x.path === "/none")?.brokenFor, null);
});

test("the costliest path comes first, not the busiest", () => {
  for (let i = 0; i < 50; i++) record("b", { url: "/favicon.ico", status: 200, ms: 3, who: "", anonId: "c" });
  record("b", { url: "/report", status: 200, ms: 4000, who: "", anonId: "c" });
  assert.equal(xray("b").paths[0].path, "/report");
});

test("who is here is counted by person, not by request", () => {
  for (let i = 0; i < 10; i++) record("c", { url: "/", status: 200, ms: 5, who: "ana@acme.com", anonId: "x" });
  record("c", { url: "/", status: 200, ms: 5, who: "bo@acme.com", anonId: "y" });
  record("c", { url: "/", status: 200, ms: 5, who: "", anonId: "anon-1" });
  const h = xray("c").here;
  assert.equal(h.count, 3);
  // Anonymous visitors are present but nameless — they are counted, never named.
  assert.deepEqual(h.names, ["ana@acme.com", "bo@acme.com"]);
});

test("a stranger walking paths cannot grow this without bound", () => {
  for (let i = 0; i < 500; i++) record("d", { url: "/p/" + i, status: 404, ms: 1, who: "", anonId: "c" });
  const x = xray("d");
  assert.ok(x.paths.length <= 60, `kept ${x.paths.length} paths`);
  // And it admits what it dropped rather than quietly showing a partial picture.
  assert.ok(x.dropped > 0, "dropped paths are reported");
});

test("measuring a request can never fail one", () => {
  assert.doesNotThrow(() => record("e", { url: null as unknown as string, status: 200, ms: 1, who: "", anonId: "c" }));
});
