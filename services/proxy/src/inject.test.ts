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

test("the panel is defined once and used in both places", async () => {
  // It started inside the overlay, which covers every app that serves HTML and
  // no app that does not. Now it is also a page at /_xray, and both import the
  // same source — two copies would drift within a week, and the one that drifted
  // would be the one nobody was looking at.
  const { XRAY_JS } = await import("./xray-panel");
  const { xrayPage } = await import("./xray-page");
  assert.ok(XRAY_JS.includes("function drawXray"), "the panel's code lives in the shared module");
  const overlay = injectOverlay("<html><body>hi</body></html>", "q6doa", true, true);
  assert.ok(overlay.includes("function drawXray"), "the overlay uses it");
  assert.ok(xrayPage("q6doa").includes("function drawXray"), "the page uses it");
});

test("the standalone page is self-contained and reads its own origin", async () => {
  const { xrayPage } = await import("./xray-page");
  const page = xrayPage("q6doa");
  assert.equal(/src\s*=\s*["']https?:/.test(page), false, "no third-party host");
  assert.ok(page.includes("fetch('/_xray'"), "reads its own origin");
  assert.doesNotThrow(() => new Function(/<script>([\s\S]*)<\/script>/.exec(page)![1]));
});

/**
 * Run the emitted overlay against a body that behaves like a hydrating app.
 *
 * THE BUG THIS PINS. The overlay is injected before </body> and runs at parse
 * time, so its host div is in the body before the tenant's own JavaScript
 * starts. A Next.js App Router app then calls hydrateRoot(document, ...) —
 * React owns the whole document, body's children included — finds a node it did
 * not render and reconciles it away. The toolbar and the badge vanish together,
 * nothing errors, and the analytics tag beside them keeps working because a
 * script that has already fired its request does not care. It reached
 * production and was found by looking at a real app.
 */
test("the overlay puts itself back when the app's hydration removes it", () => {
  const observers: (() => void)[] = [];
  const noop = () => {};
  const mk = (): Record<string, unknown> => ({
    id: "", className: "", style: { cssText: "" }, children: [] as unknown[], parentNode: null,
    appendChild(c: Record<string, unknown>) { (this.children as unknown[]).push(c); c.parentNode = this; return c; },
    removeChild(c: Record<string, unknown>) {
      this.children = (this.children as unknown[]).filter((x) => x !== c);
      c.parentNode = null;
      observers.forEach((f) => f()); // a real MutationObserver would fire here
      return c;
    },
    attachShadow() { return mk(); },
    addEventListener: noop, removeEventListener: noop, setAttribute: noop,
    getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [],
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    remove: noop, insertBefore: noop, setPointerCapture: noop,
    set innerHTML(_v: string) {}, get innerHTML() { return ""; },
    set textContent(_v: unknown) {}, get textContent() { return null; },
  });

  const body = mk();
  const g = globalThis as Record<string, unknown>;
  g.document = {
    createElement: mk, createElementNS: mk, body, documentElement: mk(),
    addEventListener: noop, fonts: { check: () => false, add: noop },
  };
  g.window = {
    innerWidth: 1400, addEventListener: noop,
    MutationObserver: class { constructor(cb: () => void) { observers.push(cb); } observe() {} },
    FontFace: function () { /* not exercised here */ },
  };
  g.MutationObserver = (g.window as Record<string, unknown>).MutationObserver;
  g.setInterval = () => 0; g.clearInterval = noop; g.setTimeout = () => 0; g.clearTimeout = noop;
  g.requestAnimationFrame = (f: () => void) => f();
  g.fetch = () => Promise.resolve({ json: () => Promise.resolve({}) });

  const page = injectOverlay("<html><body>hi</body></html>", "q6doa", true, true, "w1");
  const chunks = page.split("<script>");
  const js = chunks[chunks.length - 1].split("</scr" + "ipt>")[0];
  new Function(js)();

  assert.equal((body.children as unknown[]).length, 1, "the overlay attaches on first run");
  const host = (body.children as Record<string, unknown>[])[0];
  assert.equal(host.id, "ss-overlay");

  // React, hydrating, throws away the child it did not render.
  (body.removeChild as (c: unknown) => unknown)(host);

  assert.equal((body.children as unknown[]).length, 1, "and the overlay comes straight back");
  assert.equal((body.children as Record<string, unknown>[])[0].id, "ss-overlay");
});
