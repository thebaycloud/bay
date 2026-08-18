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

/** A reading with a people-half in it, as /_xray actually answers. */
const readingWith = (audience: unknown, window: string) => ({
  since: { live: Date.now(), audience: window },
  audience,
  live: { here: { count: 0, names: [] }, paths: [], dropped: 0 },
});

test("the people half is read from the reading, not from a second round trip", async () => {
  // /api/apps/<slug>/analytics answers whether analytics is ON. The COUNTING is
  // already read out of umami by the proxy and carried in the reading, so the
  // panel needs no endpoint of its own and no extra request — it arrives on the
  // same fetch as the live half.
  const p = panel((url) =>
    String(url).endsWith("/_xray")
      ? json(readingWith(
          { visitors: 1284, views: 3910, bounce: 38, avgSeconds: 134, change: 12,
            pages: [["/", 900]], from: [["google", 300]], on: [["Mac", 700]] },
          "read"))
      : json({ enabled: true, provisioned: true }),
  );
  const d = await p.dwLoad();
  const an = d!.an as Record<string, unknown>;
  assert.equal(an.visitors, 1284);
  assert.equal(an.views, 3910);
  assert.equal(an.mins, "2m 14s", "a mean session length said the way a person says it");
  assert.equal(an.dv, "+12%");
  assert.equal(an.dvUp, true);
  // Umami reports a bounce rate; the prototype wanted a returning count. The
  // tile shows what the number is rather than what it was wished to be.
  assert.equal(an.returning, "38%");
  assert.deepEqual(an.pages, [["/", 900]]);
  assert.equal(d!.anWindow, "read");
});

test("an unreadable window is not an app nobody visited", async () => {
  // The distinction analytics.ts keeps at the source: off is the owner's
  // decision, unreadable is ours, and neither is "nobody came". Collapsing them
  // would render a umami that is down as an app with no visitors.
  for (const [window, audience] of [["off", undefined], ["unreadable", null]] as const) {
    const p = panel((url) =>
      String(url).endsWith("/_xray") ? json(readingWith(audience, window)) : json({ enabled: true, provisioned: true }),
    );
    const d = await p.dwLoad(true);
    assert.equal(d!.an, null, `${window} leaves the tiles empty rather than showing zeros`);
    assert.equal(d!.anWindow, window);
  }
});

test("no reading at all still leaves a whole model", async () => {
  const p = panel(() => new Promise(() => {}));
  const d = await p.dwLoad();
  assert.equal(d!.an, null);
  assert.equal(d!.anWindow, "off");
});

test("the schedule and the live feed sit behind one cell", () => {
  // Neither is something an owner opens the panel FOR — one is a schedule that
  // mostly does not change, the other a stream you watch only when something is
  // wrong — and between them they took a cell and the whole leftover height of
  // home. Home is a grid again and the feed's poll only runs while it is on
  // screen, which is also why it no longer polls /_xray behind every screen.
  assert.match(DRAWER_JS, /function infraScreen/);
  assert.match(DRAWER_JS, /cell\('Infra'/);
  assert.equal(DRAWER_JS.includes("function jobsScreen"), false, "Jobs is not its own screen any more");
  // rightNowCell is defined once and called once — from infraScreen, not home.
  assert.equal((DRAWER_JS.match(/rightNowCell\(d\)/g) || []).length, 2);
});

test("nothing offers to ship, because nothing can", () => {
  // There is no deploy-trigger route. The button called one into existence on
  // the one screen about shipping, did nothing, and said nothing about doing
  // nothing.
  assert.equal(DRAWER_JS.includes("Ship again"), false);
  // And the screen shows what the deploy record actually holds instead.
  assert.match(DRAWER_JS, /Why it did not land/);
});
