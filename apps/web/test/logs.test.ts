import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterFor, normalise, quote, logNameFor, isLibraryNoise, SOURCES, LEVELS,
  type Query,
} from "../lib/logs";

/**
 * The filter, and the one thing in it that must not be wrong.
 *
 * `filterFor` composes a caller's search text into the same expression that
 * carries the app restriction. If text could escape its quotes it could close the
 * string, `OR` in another logName, and read another tenant's logs. That is the
 * boundary this file is mostly about.
 */

/* ── the escaping, which is the boundary ──────────────────────────────────── */

/**
 * How many quotes in a string are real delimiters.
 *
 * Counted by the PARITY of the backslash run before each quote, not by looking at
 * the single preceding character. `\\"` is an escaped backslash followed by a live
 * quote; `\"` is an escaped quote. The naive one-character check calls both
 * escaped, which is exactly the mistake that would make this test pass over a
 * `quote()` that does not hold — the test for a boundary has to be at least as
 * careful as the boundary.
 */
function delimiters(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '"') continue;
    let back = 0;
    for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) back++;
    if (back % 2 === 0) n++;
  }
  return n;
}

test("the counter this file trusts is itself correct", () => {
  assert.equal(delimiters('"a"'), 2);
  assert.equal(delimiters('"a\\"b"'), 2, 'an escaped quote is not a delimiter');
  assert.equal(delimiters('"a\\\\"'), 2, 'an escaped BACKSLASH leaves the quote live');
  assert.equal(delimiters('"a\\\\\\"b"'), 2);
});

test("a quote in a search cannot close the string", () => {
  // The attack: end the string, OR in another app, and read their logs.
  const evil = '" OR logName="projects/p/logs/bay.app.victim';
  const q = quote(evil);
  // Exactly two delimiters: the ones this function added.
  assert.equal(delimiters(q), 2, `escaped form has loose quotes: ${q}`);
  assert.ok(q.startsWith('"') && q.endsWith('"'));
});

test("the backslash is escaped BEFORE the quote", () => {
  // The classic ordering bug, in the one function that must not have it. Escaping
  // the quote first turns an incoming \" into \\" and leaves the quote live.
  assert.equal(quote('a\\"b'), '"a\\\\\\"b"');
  // And a lone trailing backslash cannot escape the closing quote.
  const q = quote("trailing\\");
  assert.equal(q, '"trailing\\\\"');
  assert.equal(delimiters(q), 2, "a trailing backslash must not eat the closing quote");
});

test("control characters are removed, not encoded", () => {
  // A newline inside a filter expression is a parse the API and this function
  // might read differently, and none of these can be in a message worth finding.
  assert.equal(quote("a\nb\r\tc\u0000d\u007f"), '"abcd"');
});

test("a search is capped, so a filter cannot be an essay", () => {
  const q = quote("x".repeat(5000));
  assert.ok(q.length <= 203, `got ${q.length}`);
});

test("the app restriction survives a hostile search", () => {
  const f = filterFor("shop", { search: '" OR logName="projects/p/logs/bay.app.victim' });
  // The victim's name may appear only INSIDE a quoted string, never as its own
  // logName restriction.
  assert.doesNotMatch(f, /OR logName="projects\/p\/logs\/bay\.app\.victim"/);
  assert.match(f, /bay\.app\.shop/);
});

/* ── the slug is never interpolated unchecked ─────────────────────────────── */

test("a slug that could carry filter syntax is refused, not escaped", () => {
  for (const bad of ['a" OR logName="x', "a b", "A", "-a", "a-", "", "a".repeat(70), "a/b"]) {
    assert.throws(() => filterFor(bad), /unsafe slug/, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => filterFor("a"));
  assert.doesNotThrow(() => filterFor("l3sgp"));
  assert.doesNotThrow(() => filterFor("my-app-2"));
});

/* ── the three homes ─────────────────────────────────────────────────────── */

test("all three places a line can be are searched at once", () => {
  const f = filterFor("shop");
  // Cloud Run's own logs, for an app on that runtime.
  assert.match(f, /resource\.type="cloud_run_revision" AND resource\.labels\.service_name="shop"/);
  // The node's file, shipped by the ops agent.
  assert.match(f, /log_file_path"=~"\^\/srv\/apps\/shop\//);
  // And what we publish ourselves.
  assert.match(f, /logName="projects\/[^"]+\/logs\/bay\.app\.shop"/);
});

test("the node arm is ANCHORED, because a substring leaked between tenants", () => {
  // Proven on live data: a substring filter for `subio` also returned
  // /srv/apps/subio-2/app.log — one tenant's lines inside another's query.
  const f = filterFor("subio");
  assert.match(f, /=~"\^\/srv\/apps\/subio\/"/);
  assert.doesNotMatch(f, /=~"\/srv\/apps\/subio"/);
});

/* ── the facets ──────────────────────────────────────────────────────────── */

test("asking for a side does not silently drop the streams that have none", () => {
  // `face` is a stored field, so it only filters what carries one. Backend has to
  // admit app stdout (which has no field) while excluding requests (which have no
  // side) — otherwise "backend" hides most of the backend.
  const be = filterFor("shop", { face: "backend" });
  assert.match(be, /NOT jsonPayload\.face:\*/);
  assert.match(be, /NOT jsonPayload\.source="edge"/);
  const fe = filterFor("shop", { face: "frontend" });
  assert.match(fe, /jsonPayload\.face="frontend"/);
  assert.doesNotMatch(fe, /NOT jsonPayload\.face:\*/);
});

test("`app` is identified by the ABSENCE of a source field", () => {
  // It is the one stream we do not write: it arrives from the two runtimes as
  // plain text, so there is no field to match on.
  const f = filterFor("shop", { sources: ["app"] });
  assert.match(f, /NOT jsonPayload\.source:\*/);
  const both = filterFor("shop", { sources: ["app", "edge"] });
  assert.match(both, /jsonPayload\.source="edge"/);
  assert.match(both, /NOT jsonPayload\.source:\*/);
});

test("no sources asked for means no source restriction at all", () => {
  const f = filterFor("shop", { sources: [] });
  assert.doesNotMatch(f, /jsonPayload\.source/);
});

test("every level and every source is expressible", () => {
  for (const minLevel of LEVELS) {
    assert.doesNotThrow(() => filterFor("shop", { minLevel } as Query));
  }
  assert.doesNotThrow(() => filterFor("shop", { sources: SOURCES }));
});

test("a status is an integer, never a caller's string", () => {
  // It goes in unquoted, so it is the one facet where a string would be
  // interpolated raw. Math.trunc is the guard.
  const f = filterFor("shop", { status: 500.7 });
  assert.match(f, /jsonPayload\.status=500/);
  assert.doesNotMatch(f, /500\.7/);
});

test("a method is upper-cased and quoted", () => {
  assert.match(filterFor("shop", { method: 'get" OR x="' }), /jsonPayload\.method="GET\\" OR X=\\""/);
});

/* ── normalising four shapes into one ────────────────────────────────────── */

test("a plain node line becomes an app row, with its process", () => {
  const r = normalise({
    insertId: "i1",
    timestamp: "2026-08-25T00:14:22Z",
    severity: "DEFAULT",
    textPayload: "listening on 8080",
    labels: { "agent.googleapis.com/log_file_path": "/srv/apps/shop/app.log" },
  });
  assert.equal(r.source, "app");
  assert.equal(r.face, "backend");
  assert.equal(r.process, "web", "app.log is the web process");
  assert.equal(r.msg, "listening on 8080");
  // DEFAULT is not an error and not a warning. Reported as info rather than
  // invented — the ops agent does not parse levels out of raw stdout.
  assert.equal(r.level, "info");
});

test("a worker's file names the worker", () => {
  const r = normalise({
    labels: { "agent.googleapis.com/log_file_path": "/srv/apps/shop/emailer.log" },
    textPayload: "sent 3",
  });
  assert.equal(r.process, "emailer");
});

test("a request row carries its request, and NO side", () => {
  const r = normalise({
    insertId: "i2",
    timestamp: "2026-08-25T00:14:22Z",
    severity: "INFO",
    jsonPayload: { source: "edge", method: "POST", path: "/api/users", status: 500, ms: 128 },
  });
  assert.equal(r.source, "edge");
  // The whole point: `/dashboard -> 404` is frontend routing and
  // `/api/users -> 500` is backend, and the edge cannot tell. It says nothing.
  assert.equal(r.face, null);
  assert.deepEqual(r.http, { method: "POST", path: "/api/users", status: 500, ms: 128 });
});

test("a browser row carries the page it happened on", () => {
  const r = normalise({
    jsonPayload: { source: "browser", face: "frontend", msg: "x is not a function", url: "https://shop.thebay.cloud/cart", line: 42, stack: "at f" },
    severity: "ERROR",
  });
  assert.equal(r.face, "frontend");
  assert.equal(r.level, "error");
  assert.equal(r.page?.url, "https://shop.thebay.cloud/cart");
  assert.equal(r.page?.line, 42);
});

test("rows are keyed on insertId, because timestamps collide", () => {
  // A burst writes many lines in the same millisecond. Keying a list on time
  // makes React reuse the wrong row.
  const a = normalise({ insertId: "a", timestamp: "2026-08-25T00:00:00Z", textPayload: "x" });
  const b = normalise({ insertId: "b", timestamp: "2026-08-25T00:00:00Z", textPayload: "x" });
  assert.notEqual(a.id, b.id);
  // And with no insertId there is still a key rather than undefined.
  assert.ok(normalise({ timestamp: "2026-08-25T00:00:00Z", textPayload: "x" }).id);
});

test("every severity maps somewhere, and only the loud ones are errors", () => {
  const of = (severity: string) => normalise({ severity, textPayload: "x" }).level;
  assert.equal(of("ERROR"), "error");
  assert.equal(of("CRITICAL"), "error");
  assert.equal(of("EMERGENCY"), "error");
  assert.equal(of("WARNING"), "warn");
  assert.equal(of("DEBUG"), "debug");
  assert.equal(of("NOTICE"), "info");
  assert.equal(of("DEFAULT"), "info");
  assert.equal(of(""), "info");
});

test("a protobuf timestamp is still a time", () => {
  // The tail stream hands back { seconds } rather than a string.
  const r = normalise({ timestamp: { seconds: 1787000000 }, textPayload: "x" });
  assert.match(r.at, /^20\d\d-/);
});

test("a very long line is cut, and says so", () => {
  const r = normalise({ textPayload: "x".repeat(9000) });
  assert.ok(r.msg.length < 4100);
  assert.ok(r.msg.endsWith("…"));
});

test("an entry with neither payload is still a row", () => {
  // A tail delivers whatever arrives, and a row that throws takes the stream down.
  const r = normalise({});
  assert.equal(r.msg, "");
  assert.equal(r.source, "app");
  assert.equal(r.at, "");
});

test("one log name per app, and it carries the slug", () => {
  assert.equal(logNameFor("shop"), "bay.app.shop");
});

test("no input at all can produce a loose quote", () => {
  // Three examples prove three cases. The property is about every input, so it is
  // asserted over the alphabet that could break it, at every length up to five.
  const alphabet = ['"', "\\", "a", " ", "\n"];
  const check = (s: string) => {
    const q = quote(s);
    assert.equal(delimiters(q), 2, `loose quote from ${JSON.stringify(s)} -> ${q}`);
  };
  const walk = (prefix: string, depth: number) => {
    check(prefix);
    if (depth === 0) return;
    for (const c of alphabet) walk(prefix + c, depth - 1);
  };
  walk("", 4);
});

/* ── what running it against production taught us ────────────────────────── */

test("the field the ops agent actually uses is searched", () => {
  // Every fleet app's stdout arrives as `jsonPayload.message`, not `textPayload`
  // and not our own `msg`. Searching only the other three answered "no results"
  // for `listening` while `listening on 8080` was on screen.
  const f = filterFor("shop", { search: "listening" });
  assert.match(f, /jsonPayload\.message:"listening"/);
  assert.match(f, /textPayload:"listening"/);
  assert.match(f, /jsonPayload\.msg:"listening"/);
});

test("a line the ops agent shipped is read out of jsonPayload.message", () => {
  const r = normalise({ severity: "DEFAULT" }, { message: "listening on 8080" });
  assert.equal(r.msg, "listening on 8080");
  assert.equal(r.source, "app");
});

test("an EMPTY line is empty, not a JSON blob", () => {
  // npm prints blank lines. Treating "" as absent fell through to
  // JSON.stringify(payload) and rendered `{"message":""}` in the log view.
  assert.equal(normalise({}, { message: "" }).msg, "");
  assert.equal(normalise({ textPayload: "" }).msg, "");
  // But a payload with no text at all still shows what it has, rather than
  // nothing — an entry we cannot read is not an entry we should hide.
  assert.equal(normalise({}, { weird: 1 }).msg, '{"weird":1}');
});

test("an undecoded protobuf Struct is decoded", () => {
  // The tail used to deliver these. Without decoding, every tailed line's message
  // was the wire format instead of the line.
  const r = normalise({
    jsonPayload: {
      fields: {
        message: { stringValue: "listening on 8080", kind: "stringValue" },
        source: { stringValue: "edge", kind: "stringValue" },
        status: { numberValue: 500, kind: "numberValue" },
        method: { stringValue: "GET", kind: "stringValue" },
        path: { stringValue: "/x", kind: "stringValue" },
      },
    },
  });
  assert.equal(r.source, "edge");
  assert.equal(r.http?.status, 500);
  assert.equal(r.msg, "listening on 8080");
});

test("the library's own diagnostic entry is not somebody's log line", () => {
  // @google-cloud/logging writes one of these into the log it publishes to. It is
  // our plumbing talking about our plumbing, and a tenant cannot explain it.
  assert.ok(isLibraryNoise({ "logging.googleapis.com/diagnostic": { instrumentation_source: [] } }));
  assert.ok(!isLibraryNoise({ message: "hello" }));
  assert.ok(!isLibraryNoise(null));
  assert.ok(!isLibraryNoise("a string"));
});

test("a window is always in the filter, because the library adds one otherwise", () => {
  // Measured: getEntries silently appends `AND timestamp >= <24h ago>` when the
  // filter carries no timestamp clause. Leaving it out does not mean "everything",
  // it means a day chosen by the library — which would have quietly capped the
  // retention we decided to make unlimited.
  const f = filterFor("shop", { since: "2020-01-01T00:00:00Z" });
  assert.match(f, /timestamp>="2020-01-01T00:00:00Z"/);
});

/* ── the two streams that used to be thrown away ─────────────────────────── */

test("the edge's lines are claimed by a slug AND pinned to the proxy", () => {
  // Edge lines are written to the PROXY's stdout — its service account has
  // cloudsql.client and nothing else, so it cannot call the Logging API. That
  // puts them under the proxy's service, so they are found by the slug in the
  // payload. Pinning the writer too is what stops a tenant printing
  // `{"slug":"someone-else","source":"edge"}` on its own stdout from appearing in
  // that app's log view.
  const f = filterFor("shop");
  assert.match(f, /service_name="supersonic-proxy" AND jsonPayload\.slug="shop"/);
});

test("a platform line is named by its FILE, not by a field", () => {
  // The ops agent ships every .log under /srv/apps/<slug>/ and parses none of
  // them, so there is no field to read. The filename is the label, which is why
  // this needed no config change on the node.
  const r = normalise(
    { severity: "DEFAULT", labels: { "agent.googleapis.com/log_file_path": "/srv/apps/shop/platform.log" } },
    { message: '{"at":"2026-08-25T00:00:00Z","level":"warn","msg":"was not running — restarting (1/5)"}' },
  );
  assert.equal(r.source, "platform");
  assert.equal(r.msg, "was not running — restarting (1/5)", "the JSON is unwrapped, not shown as braces");
  // DEFAULT would have made a restart read as info; the node said `warn`.
  assert.equal(r.level, "warn");
  assert.equal(r.face, null, "platform is not a side of the app");
});

test("a half-written platform line is shown, not swallowed", () => {
  // A node can die mid-line. Showing the raw text is worse than the message and
  // far better than dropping evidence of the thing that killed it.
  const r = normalise(
    { labels: { "agent.googleapis.com/log_file_path": "/srv/apps/shop/platform.log" } },
    { message: '{"level":"error","msg":"gave up sta' },
  );
  assert.equal(r.source, "platform");
  assert.match(r.msg, /gave up sta/);
});

test("app.log is still app stdout, and platform.log is not", () => {
  const app = normalise(
    { labels: { "agent.googleapis.com/log_file_path": "/srv/apps/shop/app.log" } },
    { message: "listening on 8080" },
  );
  assert.equal(app.source, "app");
  assert.equal(app.face, "backend");
  assert.equal(app.process, "web");
});
