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
    assert.ok(url.startsWith("https://app.supersonic.cv/"), `the room asks ${url} for something`);
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

test("the page knows which side of the redaction it is on", () => {
  assert.equal(/var SLUG = .*, OWNER = true/.test(pageRoom("a", { owner: true })), true);
  assert.equal(/var SLUG = .*, OWNER = false/.test(pageRoom("a", { owner: false })), true);
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
