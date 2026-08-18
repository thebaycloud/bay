import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../middleware";

/**
 * What the auth matcher must NOT catch.
 *
 * Everything here is a request that carries no session and cannot carry one, and
 * every one of them has the same failure mode: a 307 to /login where an asset
 * should be, which no browser reports as an error. A font falls back to the
 * system face, an icon to nothing, and a script simply never runs — so the bug
 * is invisible from the outside and looks like the feature was never built.
 * That has now happened twice: /fonts (the panel's typeface) and /film (the
 * deploy film the room loads from here).
 */
const matcher = new RegExp(config.matcher[0].replace(/^\//, "^/").concat("$"));

const PUBLIC = [
  "/film/ship-it.js",
  "/fonts/geist.woff2",
  "/metal/plate.webp",
  "/favicon.ico",
  "/og.png",
  "/_next/static/chunks/main.js",
];
const PROTECTED = ["/", "/apps/abc", "/settings", "/api/apps"];

test("assets that cannot carry a session are not sent to the login page", () => {
  for (const path of PUBLIC) {
    assert.equal(matcher.test(path), false, `${path} is caught by the auth matcher`);
  }
});

test("the pages that need a session still have one demanded", () => {
  for (const path of PROTECTED) {
    assert.equal(matcher.test(path), true, `${path} is NOT protected`);
  }
});
