import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import http, { type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { VisitorIdentity } from "./headers";

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

const visitor: VisitorIdentity = { userId: "usr_1", email: "boris@acme.com", name: "Boris" };

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
  process.env.FLEET_EDGE_SECRET = TEST_EDGE_SECRET;
  // idTokenFor() reaches a real GCP metadata server; irrelevant to this
  // assertion, which is about the edge header, not the ID token.
  process.env.SKIP_ID_TOKEN = "1";
  try {
    await withFakeDns(() => get(front.port));
    const headers = await up.headers;
    assert.equal(headers["x-supersonic-edge"], undefined);
  } finally {
    delete process.env.FLEET_EDGE_SECRET;
    delete process.env.SKIP_ID_TOKEN;
    front.close();
    up.close();
  }
});

test("a fleet-IP target receives no serverless-authorization header", { timeout: 5000 }, async () => {
  const up = await startUpstream();
  const front = await startFront(`http://127.0.0.1:${up.port}`);
  process.env.FLEET_EDGE_SECRET = TEST_EDGE_SECRET;
  // Deliberately NOT setting SKIP_ID_TOKEN here: this test's job is to catch
  // a regression that fires the ID-token branch for a fleet target, and
  // SKIP_ID_TOKEN would mask exactly that by skipping the branch outright
  // regardless of cloudRun. If that regression ever exists, idTokenFor()
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
    delete process.env.FLEET_EDGE_SECRET;
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
  process.env.FLEET_EDGE_SECRET = TEST_EDGE_SECRET;
  process.env.SKIP_ID_TOKEN = "1";
  try {
    await withFakeDns(() => get(front.port));
    const headers = await up.headers;
    assert.equal(headers["x-supersonic-edge"], undefined);
  } finally {
    delete process.env.FLEET_EDGE_SECRET;
    delete process.env.SKIP_ID_TOKEN;
    front.close();
    up.close();
  }
});
