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

test("home reads in the order an owner needs it", () => {
  // Address leads: the link to send someone is the thing most often wanted off
  // this panel, and it was last, underneath everything it is the subject of. It
  // takes the full row because a URL in a tint row wants the room. Everything
  // after it pairs off, so Infra and Access share the last row.
  const body = DRAWER_JS.slice(DRAWER_JS.indexOf("function homeScreen"), DRAWER_JS.indexOf("function rightNowCell"));
  const order = [...body.matchAll(/cell\('([A-Za-z ]+)'/g)].map((m) => m[1]);
  // Address and Agent are the bookends — where it lives, and how you work on it
  // — both full width, with six half-width readings between them.
  assert.deepEqual(order, ["Address", "Analytics", "Ships", "Data", "Keys", "Infra", "Access", "Agent"]);
  // The screen behind it was always /access; only the label said People, which
  // named the avatars on the row rather than the question the row answers.
  assert.match(DRAWER_JS, /access:'Access'/);
});

test("Analytics offers every dimension umami answers for", async () => {
  // The screen used to show the six figures carried in the reading, because
  // those were the only ones anything fetched. Umami answers for seventeen
  // ranked dimensions, a time series and who is on the site this second.
  const { DIMENSION_LABELS } = await import("./analytics");
  const keys = Object.keys(DIMENSION_LABELS);
  assert.ok(keys.length >= 17, `only ${keys.length} dimensions defined`);
  for (const k of keys) {
    assert.ok(DRAWER_JS.includes("'" + k + "'"), `the panel never renders ${k}`);
  }
  // Every window the route accepts is offered, and the chart exists.
  for (const r of ["1d", "7d", "30d", "1y"]) assert.ok(DRAWER_JS.includes("'" + r + "'"));
  assert.match(DRAWER_JS, /function spark\(series\)/);
  assert.match(DRAWER_CSS, /\.spark\{/);
});

test("the full read is not on the path that gets polled", () => {
  // /_xray is assembled inline on a request somebody is waiting on and polled
  // every three seconds. Twenty-odd admin queries there would be the failure
  // analytics.ts's own cache comment warns about — the analytics falling over
  // because somebody was looking at the analytics. So dwLoad must not touch it.
  const load = DRAWER_JS.slice(DRAWER_JS.indexOf("function dwLoad"), DRAWER_JS.indexOf("function dwHeading"));
  assert.equal(load.includes("_dashboard/analytics"), false, "dwLoad must not fetch the detail");
  // It is fetched by the screen instead, and it is same-origin so it needs no CORS.
  assert.match(DRAWER_JS, /fetch\('\/_dashboard\/analytics\?range='/);
});

test("Agent is one cell, because the CLI and MCP are layered and not alternatives", () => {
  // Every coding agent needs the CLI to deploy; MCP is an extra surface on top
  // for the chat-shaped tools. Two sibling cells would read as "pick one", which
  // is the one thing that is not true — a Cursor user needs both. So it is one
  // cell answering one question: how do I point my agent at this app.
  assert.match(DRAWER_JS, /cell\('Agent'/);
  assert.match(DRAWER_JS, /function agentScreen/);
  assert.equal(DRAWER_JS.includes("cell('CLI'"), false);
  assert.equal(DRAWER_JS.includes("cell('MCP'"), false);
  // Every tool gets the CLI, and the deploy line names this app.
  assert.match(DRAWER_JS, /npm i -g @supersonic\/cli/);
  assert.match(DRAWER_JS, /supersonic deploy --app '\+d\.slug/);
});

test("a tool that speaks MCP is told it is not built, not handed a config", async () => {
  // A config block would point a working tool at a server that does not exist,
  // and the failure would look like our fault in their editor rather than a
  // thing we have not made yet.
  assert.match(DRAWER_JS, /Talking to us directly/);
  assert.equal(/mcpServers|"?command"?\s*:\s*"npx"/.test(DRAWER_JS), false, "no MCP config is emitted yet");
  const p = panel((url) =>
    String(url).includes("/agent")
      ? json({ tokens: [{ id: "t1", name: "macbook", last_used_at: new Date().toISOString() }], mcp: false })
      : json({}),
  );
  const d = await p.dwLoad();
  assert.equal((d!.tokens as unknown[]).length, 1);
  assert.equal(d!.mcp, false, "mcp is false until there is a server");
});

test("last_used_at is reported as what it is: the token, not this app", async () => {
  // A token belongs to a person and deploys everything they own, so there is no
  // per-app usage to report. The copy says "used at all" rather than inventing
  // a fact the schema does not hold.
  assert.match(DRAWER_JS, /not on this app/);
  const p = panel((url) =>
    String(url).includes("/agent") ? json({ tokens: [{ id: "t1", name: "n", last_used_at: null }], mcp: false }) : json({}),
  );
  const d = await p.dwLoad();
  // A token that exists but has never been used is a different state from none.
  assert.equal((d!.tokens as { last_used_at: string | null }[])[0].last_used_at, null);
  assert.match(DRAWER_JS, /never used/);
});

test("the panel wears one accent, and green is not a second one", () => {
  // Direction C: shadcn neutral with the brand red as the only accent — primary
  // action, the selected thing, and data. Green stays reserved for status, so
  // that "live" means live and the alert state is the only thing wearing a
  // warning. A panel with two accents has no accent.
  assert.match(DRAWER_CSS, /--red:#E63F2C/);
  assert.match(DRAWER_CSS, /--green:#16A34A/);
  assert.match(DRAWER_CSS, /\.btn\.r-red\{background:var\(--red\)/, "primary is the brand red");
  assert.match(DRAWER_CSS, /\.spark \.col \.f\{[^}]*background:var\(--red\)/, "the chart carries it too");
  // The ground steps down one value so a card reads as a card. At #ffffff on
  // #ffffff the border does all the work and the panel flattens.
  assert.match(DRAWER_CSS, /--ground:#FAFAFA/);
  assert.match(DRAWER_CSS, /--white:#FFFFFF/);
});

test("the metal plates are gone, and with them two image fetches per open", () => {
  // The prototype's button was two plate images cross-fading under the cursor.
  // Beautiful, and from a different product than this one — and it made every
  // owner's page pull two webp files off the control plane to draw a button.
  assert.match(DRAWER_CSS, /\.plate,\.lit\{display:none\}/);
});
