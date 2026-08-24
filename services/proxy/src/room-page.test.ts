import { test } from "node:test";
import assert from "node:assert/strict";
import { pageRoom } from "./room-page";

test("the room asks nothing of a third party, and works without the one thing it does ask for", () => {
  const html = pageRoom("q6doa", { owner: true });
  // Served at a customer's own address by the edge. A request to any other host
  // would be a third party watching somebody's build, and a CSP-hostile page.
  //
  // ONE exception, and it is the same exception the href rule below has always
  // made: app.supersonic.cv, which is this platform and not a third party. It
  // serves the film — the 3D cut of the same build — because that picture is
  // built by the control plane and this service's deploy context (`gcloud run
  // deploy --source services/proxy`) cannot see its source. The alternative was
  // a copy of 1,500 lines of camera work that nobody would reconcile.
  //
  // What the "self-contained" rule was actually protecting is asserted below
  // instead of being assumed: the room must be a whole page with nothing
  // external. The film is additive — it is hidden until it arrives, the pixel
  // room is what stands there in the meantime, and every reason it might not
  // arrive (no WebGL, reduced motion, a small screen, a failed request) leaves
  // the page exactly as it was.
  for (const [, url] of html.matchAll(/src\s*=\s*["'](https?:[^"']+)/g)) {
    assert.ok(url.startsWith("https://app.thebay.cloud/"), `the room asks ${url} for something`);
  }
  assert.equal(/href\s*=\s*["']https?:\/\/(?!app\.supersonic\.cv)/.test(html), false);
  assert.equal(html.includes("<canvas"), true);
  // The film's own container starts hidden, so a page whose script never lands
  // shows the room rather than a hole where a picture would have been.
  assert.match(html, /<div id="film" hidden>/);
});

test("the slug is escaped, not interpolated", () => {
  const html = pageRoom('x"><script>alert(1)</script>', { owner: false });
  assert.equal(html.includes("<script>alert(1)"), false);
  assert.equal(html.includes("&lt;script&gt;"), true);
});

test("a guest is served a different page, not the same one with the film off", () => {
  // The old shape was one page and an OWNER flag, and the flag reached exactly
  // two lines of text. Everything that made the page worth looking at — the
  // film, the pixel room, the stage bar, the count of stages, which one had
  // broken — was drawn for anyone holding the link. What a guest may see is now
  // a property of WHICH PAGE THEY GET, so there is no flag left to get wrong.
  const guest = pageRoom("q6doa", { owner: false });
  assert.equal(guest.includes("ship-it.js"), false, "the guest page loads the film");
  assert.equal(guest.includes("EventSource"), false, "the guest page opens the feed");
  assert.equal(guest.includes("<script"), false, "the guest page runs script at all");
  assert.equal(guest.includes("<canvas"), false, "the guest page draws the build");
  // What it does say, which is the one thing a stranger is entitled to.
  assert.match(guest, /deploying in progress/i);
  // And it comes back on its own, so the wait ends without anyone reloading.
  assert.match(guest, /http-equiv="refresh"/);

  // The owner's page is the whole thing, and carries no flag any more.
  const owner = pageRoom("q6doa", { owner: true });
  assert.equal(/OWNER/.test(owner), false, "the owner page still branches on a flag");
  assert.equal(owner.includes("ship-it.js"), true);
});

test("the film is the whole window, not a card in the middle of one", () => {
  const html = pageRoom("q6doa", { owner: true });
  // The page stands at the app's own address with nothing else on it. A fixed
  // 720px box left most of the screen as background — and the film is composed
  // in 2.40:1, so the container has to be able to be any shape at all.
  assert.equal(/#film\{[^}]*position:absolute;inset:0/.test(html), true);
  assert.equal(/#film canvas\{[^}]*height:100%/.test(html), true);
  // The old fixed-width card is gone from all three of the things that had it.
  assert.equal(html.includes("min(92vw,720px)"), false);
  // dvh, not vh: on a phone vh is the tallest toolbar state, which puts the
  // stage bar behind the browser's own chrome.
  assert.match(html, /100dvh/);
});

test("the owner is shown the build's own words, with the deploy's clock on them", () => {
  const html = pageRoom("q6doa", { owner: true });
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
  assert.match(html, /<div id="log"><\/div>/);
  // The same shape as the bench the film is tuned on: gutter, glyph, line.
  assert.match(script, /class="t"/);
  assert.match(script, /class="k"/);
  assert.match(script, /class="m"/);
  // The time comes off the step, which the feed labels from the run's first
  // event — not from a clock the page started when the tab opened.
  assert.match(script, /step\.t/);
  // Escaped on the way in: build lines are somebody's file paths and error text,
  // and this one is written with innerHTML.
  assert.match(script, /escapeText\(l\.m\)/);
  // Written when the movement is performed, so the words and the picture are
  // describing the same moment rather than racing each other.
  assert.match(script, /if \(step\.text\) logLine\(step\);/);
});

test("the room subscribes to its own origin", () => {
  // Not app.supersonic.cv: the stream is served by the edge on the app's own
  // host, which is what lets a guest with only the link watch at all.
  assert.equal(pageRoom("a", { owner: true }).includes("EventSource('/_room/events')"), true);
});

test("nothing in the page animates on a timer alone", () => {
  const html = pageRoom("a", { owner: true });
  // The one rule. Movements come off a queue that only `enqueue` fills, and
  // `enqueue` is only called from a `steps` message. If a future edit adds a
  // setInterval that pushes work, this catches it.
  assert.equal(html.includes("setInterval"), false);
  const enqueueCalls = html.match(/enqueue\(/g) ?? [];
  assert.equal(enqueueCalls.length, 2); // the definition, and the one call site
});

test("the page's script actually parses as JavaScript", () => {
  // The client script lives inside a String.raw template, so to TypeScript it is
  // just text — a stray backtick in a comment silently ends the template and the
  // rest becomes garbage. That happened while writing this file, and nothing in
  // tsc or the type system noticed. Parsing it here is the only check that would.
  const html = pageRoom("q6doa", { owner: true });
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script && script.length > 500, "no script found in the page");
  assert.doesNotThrow(() => new Function(script as string), "the room's script does not parse");
});

test("the room draws every kind the feed can send", () => {
  // A kind with no branch in the renderer is a real line that produces no visible
  // movement, which breaks the one-line-one-movement promise silently.
  const html = pageRoom("q6doa", { owner: true });
  for (const kind of ["unpack", "detect", "prepare", "build", "pull", "provision", "release", "boot", "repair", "work", "broke"]) {
    assert.ok(html.includes("'" + kind + "'"), `the renderer never mentions ${kind}`);
  }
});


test("a stage boundary drives the film and moves nothing in the room", () => {
  // The two pictures are cut on different grains on purpose: the room walks on
  // every line, the film cuts on every stage. A stage step that reached the
  // room's queue would consume a movement slot and draw nothing, which is the
  // one-line-one-movement promise broken in the quietest possible way.
  const html = pageRoom("q6doa", { owner: true });
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
  assert.match(script, /if \(steps\[i\]\.kind === 'stage'\) \{ filmStage\(steps\[i\]\); continue; \}/);
});

test("the film is offered, never required", () => {
  const html = pageRoom("q6doa", { owner: true });
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
  // Every one of these is a reason to stay with the room, and each has to be
  // checked before a WebGL context is asked for — a page that throws while
  // deciding whether to be pretty has taken the build away from someone.
  assert.match(script, /prefers-reduced-motion/);
  assert.match(script, /innerWidth < 560/);
  assert.match(script, /getContext\('webgl2'\)/);
  assert.match(script, /window\.SupersonicFilm/);
});
