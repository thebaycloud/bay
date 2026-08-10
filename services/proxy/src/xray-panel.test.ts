import { test } from "node:test";
import assert from "node:assert/strict";
import { XRAY_JS } from "./xray-panel";
import { assembleReading } from "./reading";

/**
 * Runs the real, shipped panel source — not a copy of it — against a fake
 * host, so a future edit to drawXray's access path is caught here instead of
 * silently reaching every owner who opens the panel.
 *
 * This is why the regression in the first round of Task 8 went unnoticed:
 * `/_xray`'s JSON branch changed from returning a bare Xray to returning the
 * whole Reading, but nothing exercised drawXray against the new shape, so the
 * mismatch (`d.here` vs `d.live.here`) only threw in a browser, where the
 * poll's own `.catch(function(){})` swallowed it silently.
 *
 * No DOM library: drawXray only needs `document.createElement`, `appendChild`
 * and a settable `textContent`, so a handful of plain objects stand in for
 * real elements. This checks that drawXray *runs* against the field names
 * assembleReading actually produces, not what it draws — there is no
 * assertion on look, only on "does not throw."
 */
function fakeElement(tag: string) {
  const el: { tag: string; children: unknown[]; textContent?: string; appendChild: (c: unknown) => unknown } = {
    tag,
    children: [],
    appendChild(c: unknown) {
      el.children.push(c);
      return c;
    },
  };
  return el;
}

function runDrawXray(reading: unknown) {
  const document = { createElement: (tag: string) => fakeElement(tag) };
  const h = (tag: string, _cls?: string | null, txt?: string) => {
    const el = fakeElement(tag);
    if (txt != null) el.textContent = txt;
    return el;
  };
  const C = { slug: "lilna" };
  const fakeXr = fakeElement("div");
  // `xr` is declared by XRAY_JS itself (`var xr=null,xrTimer=null;`), so it
  // cannot be handed in as a same-named parameter — the script's own `var`
  // would win and drawXray would see null and silently no-op, defeating the
  // test. Assigning to it *after* the script has run, inside the same
  // Function body, sets the variable the script already declared.
  const fn = new Function(
    "document", "h", "C", "fakeXr", "reading",
    `${XRAY_JS}
     xr = fakeXr;
     drawXray(reading);
     return xr;`
  );
  return fn(document, h, C, fakeXr, reading);
}

test("drawXray runs against a real Reading without throwing", async () => {
  const reading = await assembleReading("lilna", {
    xray: () => ({ since: 1000, here: { count: 2, names: ["ada", "grace"] }, paths: [], dropped: 0 }),
    listBuilds: async () => [],
    door: async () => ({ door: "lilna.supersonic.cv", open: true }),
  });
  assert.doesNotThrow(() => runDrawXray(reading), "drawXray must read d.live and d.since.live, not d.* directly");
});

test("drawXray runs against an empty Reading without throwing", async () => {
  const reading = await assembleReading("new", {
    xray: () => ({ since: 42, here: { count: 0, names: [] }, paths: [], dropped: 0 }),
    listBuilds: async () => [],
    door: async () => ({ door: "new.supersonic.cv", open: false }),
  });
  assert.doesNotThrow(() => runDrawXray(reading));
});

test("drawXray runs against a Reading with paths, including a failing one", async () => {
  const reading = await assembleReading("lilna", {
    xray: () => ({
      since: 1000,
      here: { count: 0, names: [] },
      paths: [
        { path: "/api/widgets", p50: 300, p95: 1200, hits: 40, errors: 3, ago: 12 },
        { path: "/", p50: 20, p95: 80, hits: 900, errors: 0, ago: 2 },
      ],
      dropped: 4,
    }),
    listBuilds: async () => [],
    door: async () => ({ door: "lilna.supersonic.cv", open: true }),
  });
  assert.doesNotThrow(() => runDrawXray(reading));
});

test("the panel's own placeholder draw matches the shape drawXray expects", () => {
  // toggleXray() draws a placeholder before the first real fetch resolves.
  // Pulling the literal straight out of the shipped source, rather than
  // retyping it, means a future edit to one without the other fails here.
  const call = /drawXray\((\{[\s\S]*?\})\);\s*\n\s*pullXray/.exec(XRAY_JS);
  assert.ok(call, "the placeholder drawXray(...) call was not found in XRAY_JS");
  const placeholder = new Function(`return ${call![1]};`)();
  assert.doesNotThrow(() => runDrawXray(placeholder));
});

test("the panel reads the reading's live half and its own since, not the top level", () => {
  // A cheap static guard alongside the executed ones above: the access paths
  // the brief specified must actually appear in the shipped source, and the
  // shape /_xray served before this round (bare d.here / d.paths / d.dropped
  // / d.since) must not.
  assert.match(XRAY_JS, /live\.here\.count/);
  assert.match(XRAY_JS, /live\.paths/);
  assert.match(XRAY_JS, /live\.dropped/);
  assert.match(XRAY_JS, /d\.since\.live/);
  assert.doesNotMatch(XRAY_JS, /[^.]\bd\.here\b/);
  assert.doesNotMatch(XRAY_JS, /[^.]\bd\.paths\b/);
  assert.doesNotMatch(XRAY_JS, /[^.]\bd\.dropped\b/);
});

test("the poll reports a draw error instead of swallowing it", () => {
  // The empty catch is why the d.here/d.live regression reached a browser and
  // stayed invisible: drawXray threw, the catch ate it, and the panel simply
  // stopped refreshing. The owner is a developer; the console is the right
  // place for this.
  assert.doesNotMatch(XRAY_JS, /\.catch\(\s*function\s*\(\s*\)\s*\{\s*\}\s*\)/);
  assert.match(XRAY_JS, /console\.error/);
});

/**
 * Pulls the helpers out of the shipped source and calls them. XRAY_JS is only
 * function declarations and two `var`s at top level, so it evaluates with no
 * host at all -- `h`, `C` and `root` are referenced inside function bodies,
 * never at parse time.
 */
function helpers(): { dur: (s: number) => string; ago: (s: number) => string } {
  return new Function(`${XRAY_JS}
    return { dur: dur, ago: ago };`)();
}

test("dur reads as a duration and reaches past hours", () => {
  const { dur } = helpers();
  assert.equal(dur(45), "45s");
  assert.equal(dur(720), "12m");
  assert.equal(dur(18000), "5h");
  // A build stuck since 2 Aug is the reason this branch exists at all.
  assert.equal(dur(691200), "8d");
});

test("ago is dur plus a suffix, so the two cannot drift", () => {
  const { dur, ago } = helpers();
  for (const s of [45, 720, 18000, 691200]) {
    assert.equal(ago(s), dur(s) + " ago");
  }
});
