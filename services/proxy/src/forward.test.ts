import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import http, { type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { VisitorIdentity } from "./headers";
import { setIdTokenMinter } from "./idtoken";

// forward.ts imports ./config, which throws at module-evaluation time if
// AUTH_SECRET is unset — a real requirement for the running proxy, unrelated
// to anything these tests check. No other file in this suite imports
// forward.ts (or transitively config.ts), so nothing before this file has had
// to deal with it. A static `import` is hoisted above any ordinary statement
// in this file, so setting the env var first requires a dynamic import,
// done once, before any test registers. `??=` leaves a real value alone if
// one is already set.
process.env.AUTH_SECRET ??= "test-only-config-secret-do-not-log";
const { forward } = await import("./forward");
// The edge secret is read from the environment ONCE, when config.ts is
// evaluated — so setting `process.env.FLEET_EDGE_SECRET` from inside a test
// would be setting it far too late and every assertion below would pass or fail
// for the wrong reason. The tests drive the config object forward() actually
// reads. It is the same module instance, because this import resolves to the
// one forward.ts already loaded. config.test.ts covers the env read itself.
const { config } = await import("./config");

const visitor: VisitorIdentity = { userId: "usr_1", email: "dana@acme.com", name: "Dana" };

// forward() decides both which credential to send AND where to actually
// connect from the same targetBase string: isCloudRunTarget(targetBase) and
// `new URL(req.url, targetBase)` each parse it independently. Exercising the
// *.run.app branch against a local stand-in server means a fake .run.app
// hostname has to resolve to 127.0.0.1. Node's http/net internals resolve
// through the `dns` module's own exported `lookup`, so replacing that export
// for the life of one request redirects it without adding any test-only hook
// to forward.ts itself. Node 22's Happy Eyeballs connector calls it with
// `{ all: true }` and expects an address array back, not the classic
// (address, family) triple, so both shapes are handled.
function withFakeDns<T>(run: () => Promise<T>): Promise<T> {
  const original = dns.lookup;
  const fake = ((hostname: string, options: unknown, callback: unknown) => {
    const opts = (typeof options === "object" && options !== null ? options : {}) as { all?: boolean };
    const cb = (typeof options === "function" ? options : callback) as (...args: unknown[]) => void;
    if (opts.all) cb(null, [{ address: "127.0.0.1", family: 4 }]);
    else cb(null, "127.0.0.1", 4);
  }) as typeof dns.lookup;
  dns.lookup = fake;
  return run().finally(() => {
    dns.lookup = original;
  });
}

// A bare HTTP server standing in for whatever forward() proxies to — a
// tenant's Cloud Run app, or a fleet node — that resolves with the headers it
// actually received on the wire. The assertion that matters is what arrived,
// not what forward() intended to send.
function startUpstream(): Promise<{ port: number; headers: Promise<IncomingHttpHeaders>; close: () => void }> {
  return new Promise((resolveServer) => {
    let resolveHeaders!: (h: IncomingHttpHeaders) => void;
    const headers = new Promise<IncomingHttpHeaders>((r) => (resolveHeaders = r));
    const server = http.createServer((req, res) => {
      resolveHeaders(req.headers);
      res.writeHead(200);
      res.end("ok");
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolveServer({ port, headers, close: () => server.close() });
    });
  });
}

// The client-facing side forward() actually fronts, so forward() is called
// with a real IncomingMessage/ServerResponse pair rather than a hand-built
// stand-in for either.
function startFront(targetBase: string): Promise<{ port: number; close: () => void }> {
  return new Promise((resolveServer) => {
    const server = http.createServer((req, res) => {
      forward(req, res, targetBase, visitor, "acme.supersonic.cv").catch(() => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolveServer({ port, close: () => server.close() });
    });
  });
}

function get(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: "/", method: "GET" }, (res) => {
      res.resume();
      res.on("end", () => resolve());
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

// A value that never leaves this process and is never logged — these tests
// assert the fleet-secret header's presence/absence, not its contents.
const TEST_EDGE_SECRET = "test-only-edge-secret-do-not-log";

test("a Cloud Run target receives no edge secret", { timeout: 5000 }, async () => {
  const up = await startUpstream();
  const front = await startFront(`http://fake-svc-abc123-uc.a.run.app:${up.port}`);
  config.edgeSecret = TEST_EDGE_SECRET;
  // Minting reaches a real GCP metadata server; irrelevant to this assertion,
  // which is about the edge header, not the ID token. Replacing the minter
  // rather than setting an env var the forwarder reads: the branch under test
  // must be the one production takes.
  const restoreMinter = setIdTokenMinter(async () => "test-only-id-token");
  try {
    await withFakeDns(() => get(front.port));
    const headers = await up.headers;
    assert.equal(headers["x-supersonic-edge"], undefined);
    // …and the credential that MUST be there. Newly assertable: while
    // SKIP_ID_TOKEN existed this test disabled the very branch it stood next
    // to, so nothing anywhere proved that a Cloud Run upstream is called as
    // an authorised invoker. Deleting that branch is now a failing test
    // rather than a silent 403 for every tenant.
    assert.equal(headers["x-serverless-authorization"], "Bearer test-only-id-token");
  } finally {
    config.edgeSecret = "";
    restoreMinter();
    front.close();
    up.close();
  }
});

test("a fleet-IP target receives no serverless-authorization header", { timeout: 5000 }, async () => {
  const up = await startUpstream();
  const front = await startFront(`http://127.0.0.1:${up.port}`);
  config.edgeSecret = TEST_EDGE_SECRET;
  // Deliberately NOT replacing the minter here: this test's job is to catch a
  // regression that fires the ID-token branch for a FLEET target, and a
  // stub minter would let that regression through quietly by handing it a token.
  // Left alone, a regression reaches for the real GCP metadata server and it
  // reaches for the real GCP metadata server and this fails on the 5s test
  // timeout rather than the assertion below — still a failure, just a slower
  // one to diagnose. The `timeout` option keeps that bounded instead of
  // blocking the whole suite.
  try {
    await get(front.port);
    const headers = await up.headers;
    assert.equal(headers["x-serverless-authorization"], undefined);
    // And the positive side of the same branch: this is the one case that
    // must carry the fleet secret.
    assert.equal(headers["x-supersonic-edge"], TEST_EDGE_SECRET);
  } finally {
    config.edgeSecret = "";
    front.close();
    up.close();
  }
});

test("with no secret configured a fleet target is addressed unsigned", { timeout: 5000 }, async () => {
  // The bootstrap half of the same property the node has: before the secret is
  // bound to this service, fleet requests must go out exactly as they did
  // before this branch — no header, no throw — because the node's gate is off
  // too and the two deploys are not simultaneous.
  const up = await startUpstream();
  const front = await startFront(`http://127.0.0.1:${up.port}`);
  config.edgeSecret = "";
  try {
    await get(front.port);
    const headers = await up.headers;
    assert.equal(headers["x-supersonic-edge"], undefined);
  } finally {
    front.close();
    up.close();
  }
});

test("a trailing-dot Cloud Run target receives no edge secret", { timeout: 5000 }, async () => {
  // Regression test for the trailing-dot hole: a valid absolute FQDN for a
  // Cloud Run host must not be misclassified as a fleet node and handed the
  // edge secret.
  const up = await startUpstream();
  const front = await startFront(`http://fake-svc-abc123-uc.a.run.app.:${up.port}`);
  config.edgeSecret = TEST_EDGE_SECRET;
  const restoreMinter = setIdTokenMinter(async () => "test-only-id-token");
  try {
    await withFakeDns(() => get(front.port));
    const headers = await up.headers;
    assert.equal(headers["x-supersonic-edge"], undefined);
  } finally {
    config.edgeSecret = "";
    restoreMinter();
    front.close();
    up.close();
  }
});

/**
 * An upstream that behaves like a real app: it serves HTML, it validates with an
 * ETag, and it answers a conditional request with 304 — which is exactly right
 * of it, and exactly the thing that made the overlay invisible.
 */
function startHtmlUpstream(): Promise<{
  port: number;
  seen: Promise<IncomingHttpHeaders>;
  close: () => void;
}> {
  return new Promise((resolveServer) => {
    let resolveSeen!: (h: IncomingHttpHeaders) => void;
    const seen = new Promise<IncomingHttpHeaders>((r) => (resolveSeen = r));
    const server = http.createServer((req, res) => {
      resolveSeen(req.headers);
      if (req.headers["if-none-match"] === '"v1"') {
        res.writeHead(304, { ETag: '"v1"' });
        return res.end();
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        ETag: '"v1"',
        "Last-Modified": "Wed, 21 Oct 2026 07:28:00 GMT",
        "Cache-Control": "public, max-age=0, must-revalidate",
      });
      res.end("<html><body><h1>tenant</h1></body></html>");
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolveServer({ port, seen, close: () => server.close() });
    });
  });
}

function frontWithInject(targetBase: string): Promise<{ port: number; close: () => void }> {
  return new Promise((resolveServer) => {
    const server = http.createServer((req, res) => {
      forward(req, res, targetBase, visitor, "acme.supersonic.cv", {
        slug: "q6doa",
        owner: true,
        badge: false,
        websiteId: null,
      }).catch(() => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolveServer({ port, close: () => server.close() });
    });
  });
}

function fetchPage(port: number, headers: Record<string, string>) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve) => {
    const r = http.request({ host: "127.0.0.1", port, path: "/", headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.end();
  });
}

test("a page we are going to change is never requested conditionally", { timeout: 5000 }, async () => {
  // THE BUG THIS PINS. The overlay is added after the app has produced its HTML,
  // so the app's ETag describes a body the browser never receives. The browser
  // cached the injected page, revalidated with If-None-Match, the app said 304 —
  // and a 304 carries no content-type, so the injection branch never ran and the
  // 304 went straight through. The browser then kept showing the body it already
  // had, for as long as the app's own HTML was unchanged, which for a landing
  // page is forever. Four deploys appeared to do nothing because of this.
  const up = await startHtmlUpstream();
  const front = await frontWithInject(`http://127.0.0.1:${up.port}`);
  try {
    const res = await fetchPage(front.port, { "If-None-Match": '"v1"' });
    const seen = await up.seen;
    assert.equal(seen["if-none-match"], undefined, "the conditional header must not reach the app");
    assert.equal(res.status, 200, "so the app returns a whole body, not a 304");
    assert.match(res.body, /ss-overlay/, "and there is something to inject into");
  } finally {
    front.close();
    up.close();
  }
});

test("an injected page does not carry the validators of the page it is not", { timeout: 5000 }, async () => {
  const up = await startHtmlUpstream();
  const front = await frontWithInject(`http://127.0.0.1:${up.port}`);
  try {
    const res = await fetchPage(front.port, {});
    assert.equal(res.headers["etag"], undefined, "the upstream ETag described the body without the overlay");
    assert.equal(res.headers["last-modified"], undefined, "and so did Last-Modified");
    // Private, because what is in here depends on who asked: a visitor must
    // never be handed the owner's toolbar out of a shared cache.
    assert.match(String(res.headers["cache-control"]), /private/);
  } finally {
    front.close();
    up.close();
  }
});
