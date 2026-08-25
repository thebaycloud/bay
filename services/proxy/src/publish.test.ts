import { test } from "node:test";
import assert from "node:assert/strict";
import { pathOnly, severityOf, publishRequest, _resetBudgets } from "./publish";

/**
 * The line the edge publishes per request.
 *
 * The proxy stands on the path of every request to every hosted app, so anything
 * here runs a few thousand times a minute in production. Two properties matter
 * more than the shape of the output: it cannot fail a request, and it cannot cost
 * an unbounded amount.
 */

/** Capture stdout for one call. */
function emitted(fn: () => void): string[] {
  const lines: string[] = [];
  const real = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    lines.push(s);
    return true;
  };
  try {
    fn();
  } finally {
    (process.stdout as unknown as { write: typeof real }).write = real;
  }
  return lines.join("").split("\n").filter(Boolean);
}

test("a query string never reaches the log", () => {
  // It carries password reset tokens, session ids and email addresses. The path
  // is the useful half and the only half we are entitled to keep.
  assert.equal(pathOnly("/reset?token=abc123&email=a@b.com"), "/reset");
  assert.equal(pathOnly("/cart"), "/cart");
  assert.equal(pathOnly(""), "/");
  // And a pathological path is cut rather than published whole.
  assert.ok(pathOnly("/" + "x".repeat(5000)).length <= 301);
});

test("a 4xx is not an error", () => {
  // A missing favicon is the most common line any app produces. Colouring it red
  // teaches people to ignore red, and then a real 500 is just another red line.
  assert.equal(severityOf(404), "WARNING");
  assert.equal(severityOf(200), "INFO");
  assert.equal(severityOf(304), "INFO");
  assert.equal(severityOf(500), "ERROR");
  assert.equal(severityOf(503), "ERROR");
});

test("one request is one structured line, with no side", () => {
  _resetBudgets();
  const [line] = emitted(() =>
    publishRequest({ slug: "shop", method: "post", url: "/api/users?x=1", status: 500, ms: 128 }),
  );
  const j = JSON.parse(line);
  assert.equal(j.slug, "shop");
  assert.equal(j.source, "edge");
  assert.equal(j.method, "POST", "the method is normalised");
  assert.equal(j.path, "/api/users", "the query string is gone");
  assert.equal(j.status, 500);
  assert.equal(j.ms, 128);
  assert.equal(j.severity, "ERROR");
  // The whole reason Requests is its own segment: the edge cannot tell whether a
  // request belongs to the frontend or the backend, so it does not say.
  assert.equal(j.face, undefined);
});

test("an app with no slug publishes nothing", () => {
  // A request that reached the edge without resolving to an app has nowhere to
  // be filed, and a line keyed on "" would be visible to whoever asked for "".
  _resetBudgets();
  assert.deepEqual(emitted(() => publishRequest({ slug: "", method: "GET", url: "/", status: 200, ms: 1 })), []);
  assert.deepEqual(emitted(() => publishRequest({ slug: "   ", method: "GET", url: "/", status: 200, ms: 1 })), []);
});

test("one app cannot spend everybody's ingest allowance", () => {
  // Cost is driven by volume, not by retention: one app at 100 lines a second is
  // about 260 GiB a month on its own. This ceiling is the only thing that bounds
  // it, and it is per app so a busy tenant cannot starve the others.
  _resetBudgets();
  const lines = emitted(() => {
    for (let i = 0; i < 200; i++) {
      publishRequest({ slug: "loud", method: "GET", url: "/", status: 200, ms: 1 });
    }
  });
  assert.ok(lines.length <= 20, `published ${lines.length} in one second`);
  assert.ok(lines.length > 0, "and it is a ceiling, not a mute");
});

test("a quiet app is unaffected by a loud one", () => {
  _resetBudgets();
  const lines = emitted(() => {
    for (let i = 0; i < 200; i++) publishRequest({ slug: "loud", method: "GET", url: "/", status: 200, ms: 1 });
    publishRequest({ slug: "quiet", method: "GET", url: "/only-one", status: 200, ms: 1 });
  });
  assert.ok(
    lines.some((l) => JSON.parse(l).path === "/only-one"),
    "the quiet app's line was dropped with the loud one's",
  );
});

test("dropping is said out loud, not sampled silently", async () => {
  // A view that quietly dropped lines would be worse than one that admits it:
  // the first teaches people the logs are complete when they are not.
  _resetBudgets();
  emitted(() => {
    for (let i = 0; i < 200; i++) publishRequest({ slug: "loud", method: "GET", url: "/", status: 200, ms: 1 });
  });
  await new Promise((r) => setTimeout(r, 1100));
  const next = emitted(() => publishRequest({ slug: "loud", method: "GET", url: "/after", status: 200, ms: 1 }));
  const notice = next.map((l) => JSON.parse(l)).find((j) => typeof j.message === "string");
  assert.ok(notice, "the next second says nothing about what was lost");
  assert.match(notice.message, /dropped/);
  assert.equal(notice.severity, "WARNING");
});

test("publishing can never throw into the request path", () => {
  // This runs inside `measure`, which finishes a response. An exception here
  // would fail a request that had already succeeded.
  _resetBudgets();
  const real = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: () => boolean }).write = () => {
    throw new Error("stdout is gone");
  };
  try {
    assert.doesNotThrow(() =>
      publishRequest({ slug: "shop", method: "GET", url: "/", status: 200, ms: 1 }),
    );
  } finally {
    (process.stdout as unknown as { write: typeof real }).write = real;
  }
});
