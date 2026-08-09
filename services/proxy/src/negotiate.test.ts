import { test } from "node:test";
import assert from "node:assert/strict";
import { wantsHtml } from "./negotiate";

test("an unknown client is treated as a machine, not as a browser", () => {
  // A bare fetch() sends */* per the Fetch Standard — including our own poll at
  // xray-panel.ts:116. Written the other way round ("if they ask for JSON, send
  // JSON") that poll would receive the HTML page. The safe default is machine.
  assert.equal(wantsHtml("*/*"), false);
  assert.equal(wantsHtml(undefined), false);
  assert.equal(wantsHtml(""), false);
});

test("a browser is recognised by asking for html", () => {
  assert.equal(wantsHtml("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"), true);
  assert.equal(wantsHtml("TEXT/HTML"), true);
});

test("asking explicitly for json gets json", () => {
  assert.equal(wantsHtml("application/json"), false);
});
