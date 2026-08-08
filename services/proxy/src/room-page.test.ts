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
