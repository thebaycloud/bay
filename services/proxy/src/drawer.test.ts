import test from "node:test";
import assert from "node:assert/strict";

import { DRAWER_JS, DRAWER_CSS } from "./drawer";

/**
 * Evaluate the shipped panel source with just enough of a browser around it.
 *
 * The panel is a string of JavaScript that only ever runs inside a shadow root
 * on somebody else's page, so the only way to test it is the way it is served:
 * as source, evaluated. `fetch` is the seam — every one of these tests is about
 * what the panel does when the answers are slow, absent or wrong.
 */
function panel(fetchImpl: (url: string) => Promise<unknown>) {
  const noop = () => {};
  const node = () => ({
    className: "", textContent: null as unknown, children: [] as unknown[],
    style: { setProperty: noop }, dataset: {}, hidden: false, scrollTop: 0, offsetWidth: 1,
    appendChild(c: unknown) { this.children.push(c); return c; },
    removeChild: noop, remove: noop, insertBefore: noop,
    addEventListener: noop, removeEventListener: noop, setPointerCapture: noop,
    setAttribute: noop, getAttribute: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    set innerHTML(_v: string) { this.children.length = 0; },
    get innerHTML() { return ""; },
  });
  const g = globalThis as Record<string, unknown>;
  g.document = { createElement: node, createElementNS: node, addEventListener: noop, body: node() };
  g.window = { innerWidth: 1400, addEventListener: noop };
  g.fetch = fetchImpl;
  const C = { slug: "notes", app: "https://app.supersonic.cv" };
  const make = new Function("C", "root", "h", `${DRAWER_JS}\nreturn {dwLoad, dwSoon};`);
  return make(C, node(), node) as {
    dwLoad: (force?: boolean) => Promise<Record<string, unknown> | null>;
    dwSoon: <T>(p: Promise<T>, ms: number, fallback: T) => Promise<T>;
  };
}

const json = (body: unknown) => Promise.resolve({ json: () => Promise.resolve(body) });

test("a request that never answers cannot leave the panel loading forever", async () => {
  // THE BUG THIS PINS. Everything is fetched at once so home can carry a fact
  // per cell, and the first version of that awaited Promise.all with no deadline
  // on any of the eight. /_xray assembles its reading from Umami, which
  // reading.ts itself says can be off or unreachable — so when it hung, the
  // panel sat on "Reading…" indefinitely: no data, no error, nothing in the
  // console. It shipped that way and was found by looking at it in production.
  const p = panel(() => new Promise(() => {})); // never resolves. not once.
  const d = await p.dwLoad();
  assert.ok(d, "dwLoad must settle even when every request hangs");
  assert.equal(d!.slug, "notes");
  // The shape still has to be whole, because the screens index into it blind.
  assert.deepEqual(d!.tables, []);
  assert.deepEqual(d!.keys, []);
  assert.equal(Array.isArray(d!.ships), true);
  assert.equal((d!.ships as unknown[]).length, 1, "there is always a ships row to read [0] of");
});

test("one slow answer does not cost the other seven", async () => {
  const p = panel((url) =>
    String(url).endsWith("/_xray")
      ? new Promise(() => {})
      : json({ tables: [{ table_name: "notes", n_live_tup: 12 }], keys: ["STRIPE_KEY"] }),
  );
  const d = await p.dwLoad();
  assert.deepEqual(d!.tables, [["notes", 12]], "the db answer survives the hanging one");
  assert.deepEqual(d!.here, [], "and the hanging one degrades to empty rather than undefined");
});

test("dwSoon resolves to its fallback rather than rejecting", async () => {
  const p = panel(() => json({}));
  assert.equal(await p.dwSoon(Promise.reject(new Error("nope")), 50, "fallback"), "fallback");
  assert.equal(await p.dwSoon(new Promise(() => {}), 50, "fallback"), "fallback");
  assert.equal(await p.dwSoon(Promise.resolve("real"), 50, "fallback"), "real");
});

test("a deploy is finished when its status says so, never when its stage does", async () => {
  // deploys.ts has no 'done' stage — status is live | building | deploying |
  // pending | failed | canceled, and stage holds the last step that ran. Reading
  // stage for doneness left every finished app saying "Shipping" forever.
  const at = new Date(Date.now() - 7200e3).toISOString();
  for (const [status, out, shipping] of [
    ["live", "shipped", false],
    ["failed", "never left", false],
    ["building", "live", true],
  ] as const) {
    const p = panel((url) =>
      String(url).includes("/deploy-status")
        ? json({ deploy: { name: "add search", status, stage: "verify", finishedAt: at } })
        : json({}),
    );
    const d = await p.dwLoad(true);
    assert.equal((d!.ships as { out: string }[])[0].out, out, `status ${status} reads as ${out}`);
    assert.equal(d!.shipping, shipping, `status ${status} shipping=${shipping}`);
  }
});

test("the panel carries its own base type, because a shadow root has no body", () => {
  // The prototype set font-family on `body`. There is no body in a shadow root,
  // and dropping that rule is why every heading rendered in the browser's
  // default serif. It cannot live on :host either — inject.ts sets all:initial
  // INLINE on the host, and an inline declaration beats an author rule.
  assert.match(DRAWER_CSS, /\.drawer\{font-family:var\(--sans\)/);
});

test("the panel never defines a global that would silently kill the script", () => {
  // top/self/parent/closed/length are [LegacyUnforgeable] on Window: a global
  // with one of those names makes the WHOLE script fail to evaluate, with no
  // error and a blank panel. This is how the recovered prototype was broken.
  const globals = [...DRAWER_JS.matchAll(/^(?:var|function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  const unforgeable = ["window", "document", "location", "top", "self", "parent", "frames", "closed", "length"];
  assert.deepEqual(globals.filter((n) => unforgeable.includes(n)), []);
});
