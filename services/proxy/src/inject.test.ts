import { test } from "node:test";
import assert from "node:assert/strict";

// `inject` pulls in `config`, which refuses to load without this — a real
// requirement of the running proxy and nothing to do with what is tested here.
// Set before the import, exactly as forward.test.ts and config.test.ts do.
process.env.AUTH_SECRET ??= "test-only-config-secret-do-not-log";

const { injectOverlay, hasOverlay, isHtmlDocument } = await import("./inject");

const asOwner = () => injectOverlay("<html><body>hi</body></html>", "q6doa", true, true);
const asVisitor = () => injectOverlay("<html><body>hi</body></html>", "q6doa", false, true);

test("a visitor is never told the x-ray exists", () => {
  const html = asVisitor();
  // Not the button, not the endpoint, not the shortcut. The whole layer is the
  // owner's private view of their own app, and a visitor should not be able to
  // learn from the page that /_xray means anything at all.
  assert.equal(html.includes("X-ray"), false);
  assert.equal(html.includes("/_xray"), false);
  assert.equal(html.includes("toggleXray"), false);
});

test("the owner gets the button, the shortcut and the feed", () => {
  const html = asOwner();
  assert.equal(html.includes("X-ray"), true);
  assert.equal(html.includes("fetch('/_xray'"), true);
  assert.equal(html.includes("keydown"), true);
});

test("the x-ray asks the app's own origin, not the control plane", () => {
  // Same-origin is what makes this work with the session cookie and with no CORS,
  // and it is also the point: the numbers come from the edge in front of THIS
  // app, not from a dashboard somewhere else.
  assert.equal(/fetch\((["'])https?:\/\/[^)]*_xray/.test(asOwner()), false);
});

test("the overlay script parses as JavaScript", () => {
  // It is built as a string, so nothing in the type system checks it — a stray
  // backtick or quote in a comment silently breaks the whole overlay, badge and
  // toolbar included, on every hosted app at once.
  for (const html of [asOwner(), asVisitor()]) {
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
    assert.ok(script && script.length > 500, "no overlay script found");
    assert.doesNotThrow(() => new Function(script as string));
  }
});

test("an app with nothing to inject is left alone", () => {
  // A paid app viewed by a stranger has no badge and no toolbar; buffering the
  // whole HTML response to add an empty shadow root is a cost charged to every
  // page view of the customers who pay us not to be branded.
  assert.equal(hasOverlay(false, false), false);
  assert.equal(hasOverlay(true, false), true);
  assert.equal(hasOverlay(false, true), true);
});

test("only real HTML documents are decorated", () => {
  assert.equal(isHtmlDocument("text/html; charset=utf-8"), true);
  assert.equal(isHtmlDocument("application/json"), false);
  assert.equal(isHtmlDocument(undefined), false);
});
