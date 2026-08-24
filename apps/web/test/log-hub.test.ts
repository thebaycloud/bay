import { test } from "node:test";
import assert from "node:assert/strict";
import { matches } from "../lib/log-hub";
import type { LogRow, Query } from "../lib/logs";

/**
 * The tail's filter, which is a SECOND implementation of `filterFor`.
 *
 * That duplication is deliberate and bounded: one upstream Cloud Logging tail is
 * shared by every viewer of an app, because the API caps concurrent streams — so
 * the upstream cannot carry any one viewer's filter and somebody has to narrow it
 * here. The risk of two implementations is that they disagree, and a tail showing
 * rows the paged read does not is the kind of inconsistency that makes a log view
 * feel haunted. So the awkward cases are pinned here, in the same words as
 * test/logs.test.ts pins them for the filter.
 */

const row = (o: Partial<LogRow> = {}): LogRow => ({
  id: "x",
  at: "2026-08-25T00:00:00Z",
  source: "app",
  face: "backend",
  level: "info",
  msg: "",
  process: "web",
  release: null,
  http: null,
  page: null,
  ...o,
});

const req = (status: number, path = "/", method = "GET") =>
  row({ source: "edge", face: null, http: { method, path, status, ms: 5 } });

test("nothing asked for matches everything", () => {
  assert.ok(matches(row(), {}));
  assert.ok(matches(req(200), {}));
});

test("a request belongs to NEITHER side, so neither side shows it", () => {
  // The whole reason Requests is its own segment. `/dashboard -> 404` is frontend
  // routing and `/api/users -> 500` is backend; the edge cannot tell, so it says
  // nothing and a side filter must not claim it.
  assert.equal(matches(req(500, "/api/users"), { face: "backend" }), false);
  assert.equal(matches(req(404, "/dashboard"), { face: "frontend" }), false);
  // And the segment that does want them, gets them.
  assert.ok(matches(req(500), { sources: ["edge"] }));
});

test("backend admits app stdout, which carries no side of its own", () => {
  // If `backend` only matched rows with face==="backend" set by us, it would hide
  // every line the app printed — which is most of the backend.
  assert.ok(matches(row({ source: "app", face: "backend" }), { face: "backend" }));
  assert.ok(matches(row({ source: "platform", face: "backend" }), { face: "backend" }));
  assert.equal(matches(row({ source: "browser", face: "frontend" }), { face: "backend" }), false);
});

test("frontend is the browser and nothing else", () => {
  assert.ok(matches(row({ source: "browser", face: "frontend" }), { face: "frontend" }));
  assert.equal(matches(row({ source: "app", face: "backend" }), { face: "frontend" }), false);
});

test("a level filter is a FLOOR, not an equality", () => {
  assert.ok(matches(row({ level: "error" }), { minLevel: "warn" }));
  assert.ok(matches(row({ level: "warn" }), { minLevel: "warn" }));
  assert.equal(matches(row({ level: "info" }), { minLevel: "warn" }), false);
  assert.equal(matches(row({ level: "debug" }), { minLevel: "info" }), false);
  assert.ok(matches(row({ level: "debug" }), { minLevel: "debug" }));
});

test("search looks where the text actually is", () => {
  // A message, a request path and a browser URL are three different fields and a
  // search that missed any of them would answer "not found" about a row on screen.
  assert.ok(matches(row({ msg: "listening on 8080" }), { search: "LISTENING" }));
  assert.ok(matches(req(200, "/api/cart"), { search: "cart" }));
  assert.ok(
    matches(row({ source: "browser", face: "frontend", page: { url: "https://a/checkout" } }), { search: "checkout" }),
  );
  assert.equal(matches(row({ msg: "hello" }), { search: "goodbye" }), false);
});

test("search is case-insensitive and trimmed, like the box people type into", () => {
  assert.ok(matches(row({ msg: "TypeError" }), { search: "  typeerror  " }));
  // An empty box is not a filter.
  assert.ok(matches(row({ msg: "anything" }), { search: "   " }));
});

test("the request facets narrow requests and exclude everything else", () => {
  assert.ok(matches(req(500), { status: 500 }));
  assert.equal(matches(req(200), { status: 500 }), false);
  // A row with no request cannot satisfy a request facet, and must not slip
  // through it either.
  assert.equal(matches(row({ msg: "x" }), { status: 500 }), false);
  assert.ok(matches(req(200, "/", "post"), { method: "post" }), "method is compared case-insensitively");
  assert.ok(matches(req(200, "/api/users/3"), { path: "/api/users" }), "path is a substring");
  assert.equal(matches(req(200, "/health"), { path: "/api" }), false);
});

test("a source list is exclusive", () => {
  assert.ok(matches(row({ source: "platform" }), { sources: ["platform", "deploy"] }));
  assert.equal(matches(row({ source: "app" }), { sources: ["platform"] }), false);
  // Empty means no restriction, not "match nothing" — the difference between a
  // cleared filter and a filter that hides everything.
  assert.ok(matches(row({ source: "app" }), { sources: [] }));
});

test("filters compose, and any one of them can refuse", () => {
  const q: Query = { face: "backend", minLevel: "warn", search: "boom" };
  assert.ok(matches(row({ level: "error", msg: "boom happened" }), q));
  assert.equal(matches(row({ level: "info", msg: "boom happened" }), q), false, "level refuses");
  assert.equal(matches(row({ level: "error", msg: "all fine" }), q), false, "search refuses");
  assert.equal(
    matches(row({ source: "browser", face: "frontend", level: "error", msg: "boom" }), q),
    false,
    "side refuses",
  );
});
