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
  assert.equal(p?.errors, 1);
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
