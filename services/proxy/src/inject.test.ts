import { test } from "node:test";
import assert from "node:assert/strict";

// `inject` pulls in `config`, which refuses to load without this — a real
// requirement of the running proxy and nothing to do with what is tested here.
// Set before the import, exactly as forward.test.ts and config.test.ts do.
process.env.AUTH_SECRET ??= "test-only-config-secret-do-not-log";

const { injectOverlay, hasOverlay, isHtmlDocument } = await import("./inject");

const asOwner = () => injectOverlay("<html><body>hi</body></html>", "q6doa", true, true);
const asVisitor = () => injectOverlay("<html><body>hi</body></html>", "q6doa", false, true);

test("a visitor is never told the dashboard exists", () => {
  const html = asVisitor();
  // Not the button, not the address, not the shortcut. The whole layer is the
  // owner's private view of their own app, and a visitor must not be able to
  // learn from the page that /_dashboard means anything at all.
  for (const tell of ["Dashboard", "/_dashboard", "/_xray", "openDrawer", "homeScreen"]) {
    assert.equal(html.includes(tell), false, `a visitor can see ${tell}`);
  }
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

test("an owner's own app page carries a link, not a dashboard", () => {
  // The panel used to ride this overlay. It lives at app.supersonic.cv/apps/<slug>
  // now, so what an owner downloads on every page of their own app is a pill: the
  // app's name, its state, and a link. Two properties follow and both are the
  // point — the bytes, and the fact that there is almost nothing left in a
  // tenant's document for a visitor to read out of it.
  const overlay = injectOverlay("<html><body>hi</body></html>", "q6doa", true, true);
  assert.ok(overlay.includes("class='pill'") || overlay.includes("'pill'"), "the pill is there");
  assert.ok(overlay.includes("/apps/'+C.slug"), "and it links to the workbench");
  for (const gone of ["function homeScreen", "function dwLoad", "function screen(", "Right now"]) {
    assert.equal(overlay.includes(gone), false, `${gone} should not ship any more`);
  }
});

test("the pill asks its own origin for one word, not the control plane for nine", () => {
  const overlay = injectOverlay("<html><body>hi</body></html>", "q6doa", true, true);
  assert.ok(overlay.includes("fetch('/_xray'"), "same-origin, so no CORS and no bearer");
  // dwLoad fanned out nine reads to build a panel. A pill needs one word, and
  // asking for nine to draw a dot would be the panel's cost without the panel.
  assert.equal((overlay.match(/\/api\/apps\//g) ?? []).length, 0);
});

test("the injected script never defines a global that would silently kill it", () => {
  // top/self/parent/closed/length are [LegacyUnforgeable] on Window: a global with
  // one of those names makes the WHOLE script fail to evaluate, with no error and
  // nothing rendered. This is how the recovered prototype was broken, and it
  // outlived the panel it was found in — the pill is still injected source.
  const overlay = injectOverlay("<html><body>hi</body></html>", "q6doa", true, true);
  const script = /<script>([\s\S]*?)<\/script>/.exec(overlay)![1];
  const globals = [...script.matchAll(/^(?:var|function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  const unforgeable = ["window", "document", "location", "top", "self", "parent", "frames", "closed", "length"];
  assert.deepEqual(globals.filter((n) => unforgeable.includes(n)), []);
});

test("the injected script evaluates, so a stray backtick cannot ship silently", () => {
  // CSS and JS reach the browser inside String.raw. A backtick or ${} in either
  // closes the literal early: the browser then evaluates something that PARSES,
  // throws nothing, leaves the console clean, and renders wrong. That is how the
  // stylesheet once became the string "NaN".
  const overlay = injectOverlay("<html><body>hi</body></html>", "q6doa", true, true);
  const script = /<script>([\s\S]*?)<\/script>/.exec(overlay)![1];
  assert.doesNotThrow(() => new Function(script));
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

/**
 * The stylesheet has to survive being carried through a template literal.
 *
 * THE BUG THIS PINS. The CSS is emitted inside a JS template literal in the
 * overlay script, so a stray backtick anywhere in it closes the string early. A
 * comment in inject.ts once contained two, wrapped around the universal
 * selector, and the browser then evaluated "...sit on " * ", which..." — string
 * times string — assigned NaN to the stylesheet, and rendered the whole overlay
 * unstyled: position static, display block, sitting as plain text six thousand
 * pixels down a long page. It parsed. It ran. It threw nothing. The console was
 * clean and the toolbar was simply not where anyone would look.
 *
 * Asserting the script parses is not enough — it did, every time. This evaluates
 * it and reads the stylesheet back off the shadow root.
 */
test("the overlay's stylesheet arrives whole, not as the string NaN", () => {
  const noop = () => {};
  const styles: string[] = [];
  const mk = (tag?: string): Record<string, unknown> => ({
    tagName: tag, id: "", className: "", style: { cssText: "" }, children: [] as unknown[],
    appendChild(c: Record<string, unknown>) { (this.children as unknown[]).push(c); return c; },
    attachShadow() { return mk("#shadow"); },
    addEventListener: noop, removeEventListener: noop, setAttribute: noop,
    getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [],
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    removeChild: noop, remove: noop, insertBefore: noop, setPointerCapture: noop,
    set innerHTML(_v: string) {}, get innerHTML() { return ""; },
    set textContent(v: unknown) { if (this.tagName === "style") styles.push(String(v)); },
    get textContent() { return null; },
  });
  const g = globalThis as Record<string, unknown>;
  g.document = {
    createElement: (t: string) => mk(t), createElementNS: (_n: string, t: string) => mk(t),
    body: mk("body"), documentElement: mk("html"), addEventListener: noop,
    fonts: { check: () => false, add: noop },
  };
  g.window = { innerWidth: 1400, addEventListener: noop, MutationObserver: class { observe() {} }, FontFace: function () {} };
  g.MutationObserver = (g.window as Record<string, unknown>).MutationObserver;
  g.setInterval = () => 0; g.clearInterval = noop; g.setTimeout = () => 0; g.clearTimeout = noop;
  g.requestAnimationFrame = (f: () => void) => f();
  g.fetch = () => Promise.resolve({ json: () => Promise.resolve({}) });

  const page = injectOverlay("<html><body>hi</body></html>", "q6doa", true, true, "w1");
  const chunks = page.split("<script>");
  new Function(chunks[chunks.length - 1].split("</scr" + "ipt>")[0])();

  assert.equal(styles.length, 1, "exactly one stylesheet goes into the shadow root");
  const css = styles[0];
  // The failure this test exists for: a backtick inside String.raw closed the
  // literal early, the browser evaluated "…" * "…", and the stylesheet became the
  // NUMBER NaN. It parsed, it ran, it threw nothing, the console was clean, and the
  // whole overlay rendered unstyled 6,000px down the page. The panel is gone and
  // this hazard is not — the pill is still built the same way.
  assert.notEqual(css, "NaN", "a stray backtick turns the whole stylesheet into a multiplication");
  // The rules the pill cannot be seen without.
  assert.match(css, /\.pill\{position:fixed/, "the pill must be pinned, not left in the page flow");
  assert.match(css, /\.pill i\.ok\{background:#16A34A\}/, "green is status, and status is green");
  assert.match(css, /:host\{all:initial/);
});
