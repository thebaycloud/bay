import { test } from "node:test";
import assert from "node:assert/strict";
import { pageRoom } from "./room-page";

test("the room is one self-contained document", () => {
  const html = pageRoom("q6doa", { owner: true });
  // Served at a customer's own address by the edge. A request to any other host
  // would be a third party watching somebody's build, and a CSP-hostile page.
  assert.equal(/src\s*=\s*["']https?:/.test(html), false);
  assert.equal(/href\s*=\s*["']https?:\/\/(?!app\.supersonic\.cv)/.test(html), false);
  assert.equal(html.includes("<canvas"), true);
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
