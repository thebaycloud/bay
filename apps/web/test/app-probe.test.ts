import { test } from "node:test";
import assert from "node:assert/strict";
import { probeSummary, bodyPreview } from "../lib/app-probe";

test("an app that answers 400 is not reported as live", () => {
  // The defect this exists to fix. `epvmx` serves Django's DisallowedHost — it
  // is running, reachable, and refusing every request — and the dashboard drew
  // the same green LIVE on it as on a working app, because `ready` is Cloud
  // Run's opinion of the REVISION and nobody had asked the app anything.
  const s = probeSummary({ code: 400, ms: 42 });

  assert.equal(s.verdict, "warn");
  assert.equal(s.label, "400 · 42 ms");
  assert.notEqual(s.verdict, "ok");
});

test("no answer at all is down, and says so rather than showing a zero", () => {
  const s = probeSummary({ code: 0, ms: 5000 });

  assert.equal(s.verdict, "down");
  assert.equal(s.label, "no answer");
});

test("a 5xx is down and a redirect is not", () => {
  assert.equal(probeSummary({ code: 503, ms: 12 }).verdict, "down");
  // An app that redirects its root to /login is working. Calling that "down"
  // is the same mistake in the other direction.
  assert.equal(probeSummary({ code: 302, ms: 12 }).verdict, "ok");
  assert.equal(probeSummary({ code: 200, ms: 12 }).verdict, "ok");
});

test("a 404 at the root is not a failure, because plenty of APIs have no root", () => {
  // Deliberately `warn` rather than `down`: it is worth showing, and it is not
  // the same as the app being unreachable. The same rule the fleet's verdict
  // uses — only 5xx and silence are failures.
  assert.equal(probeSummary({ code: 404, ms: 8 }).verdict, "warn");
});

test("an API shows what it said; a page does not", () => {
  // The whole reason the probe beats a screenshot for some apps. A screenshot of
  // {"ok":true} is a picture of the word "ok" on a white field, and a screenshot
  // of a giant "E" is what a monogram fallback already draws.
  assert.equal(
    bodyPreview('{"ok":true,"version":"1.4.0"}', "application/json"),
    '{"ok":true,"version":"1.4.0"}',
  );
  // An HTML page has a screenshot, which says more than its markup ever would.
  assert.equal(bodyPreview("<!doctype html><html><head><title>x", "text/html; charset=utf-8"), "");
});

test("a preview is one line and a bounded one", () => {
  // It lands in a fixed-height card. Newlines would break the row and a long
  // body would push the facts beside it off the shelf.
  const long = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => `item-${i}`) });
  const p = bodyPreview(long, "application/json");

  assert.ok(p.length <= 120, `preview was ${p.length} chars`);
  assert.ok(!p.includes("\n"));
  assert.ok(p.endsWith("…"), "a truncated preview says it was truncated");
  assert.equal(bodyPreview("line one\nline two", "text/plain"), "line one line two");
});
