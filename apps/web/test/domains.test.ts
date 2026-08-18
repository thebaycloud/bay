import { test, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * Connecting a domain, against no database and no Google.
 *
 * Three separable things live in here and only one of them is worth a network:
 * what counts as a hostname somebody may attach (pure), what the certificate's
 * shape and state mean (pure), and what one reconcile step decides given what
 * DNS and Certificate Manager just said (pure, with both of them injected).
 *
 * The database is mocked for the same reason lib/entitlements' tests mock it:
 * `getPool` points at 127.0.0.1:5433, so a test that "just tried it" would
 * quietly write into the shared platform database on any machine with
 * cloud-sql-proxy running.
 */

type Result = { rows: unknown[]; rowCount: number };
type Handler = (sql: string, params: unknown[]) => Result;

let handler: Handler = () => ({ rows: [], rowCount: 0 });
let queryThrows: unknown = null;
const sent: { sql: string; params: unknown[] }[] = [];

mock.module("@/lib/db", {
  namedExports: {
    getPool: () => ({
      query: async (sql: string, params: unknown[] = []) => {
        if (queryThrows) throw queryThrows;
        sent.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
        return handler(sql, params);
      },
    }),
  },
});

function withDb(h: Handler, throws: unknown = null): void {
  handler = h;
  queryThrows = throws;
  sent.length = 0;
}

// Deferred rather than static, so these load below `mock.module` — a static
// import is hoisted above it and would take the real lib/db with it.
const domains$ = import("@/lib/domains");
const cert$ = import("@/lib/domain-cert");
const attach$ = import("@/lib/domain-attach");

/* ------------------------------------------------------------------ naming */

test("what a person types is reduced to the name it means", async () => {
  const { normalizeHostname } = await domains$;
  // All four spellings are one name, and one name has to be one row: the
  // primary key on app_domains is the whole of "one hostname, one app".
  for (const typed of ["shop.acme.com", "SHOP.Acme.com", " shop.acme.com ", "shop.acme.com."]) {
    assert.equal(normalizeHostname(typed), "shop.acme.com", typed);
  }
  // People paste addresses, not hostnames.
  assert.equal(normalizeHostname("https://shop.acme.com/pricing?x=1"), "shop.acme.com");
  assert.equal(normalizeHostname("acme.com:8080"), "acme.com");
});

test("things that are not a name somebody can own are refused before anything is written", async () => {
  const { normalizeHostname } = await domains$;
  for (const bad of [
    "",                       // nothing
    "localhost",              // no dot: not a name anybody owns
    "com",
    "*.acme.com",             // load-balancer authorization cannot issue a wildcard at all
    "192.168.0.1",            // an address, not a name
    "1.2.3.4",
    "acme..com",              // an empty label
    "-acme.com",              // a label may not begin with a hyphen
    "acme.com-",
    "a".repeat(64) + ".com",  // DNS refuses a label over 63 octets
    ("a".repeat(60) + ".").repeat(5) + "com", // and a name over 253
  ]) {
    assert.equal(normalizeHostname(bad), null, bad);
  }
});

test("a name inside supersonic.cv is issued by us, never attached by a person", async () => {
  const { refuseHostname } = await domains$;
  assert.ok(refuseHostname("other-app.supersonic.cv"));
  assert.ok(refuseHostname("supersonic.cv"));
  assert.ok(refuseHostname("printer.local"));
  assert.equal(refuseHostname("acme.com"), null);
  // The suffix test is on a label boundary, not a string: this is somebody
  // else's domain that merely ends in our name.
  assert.equal(refuseHostname("notsupersonic.cv"), null);
});

/* ------------------------------------------------------- certificate naming */

test("two hostnames can never share a certificate id", async () => {
  const { certIdFor } = await cert$;
  // Both flatten to the same readable part; only the hash keeps them apart, and
  // a collision here would point one person's domain at another's certificate.
  assert.notEqual(certIdFor("shop.acme.com"), certIdFor("shop-acme.com"));
  const long = "a".repeat(60) + ".acme.com";
  const other = "a".repeat(60) + ".acme.net";
  assert.notEqual(certIdFor(long), certIdFor(other), "a truncated name must not collide with its neighbour");
  assert.equal(certIdFor("shop.acme.com"), certIdFor("shop.acme.com"), "creating it twice must be the same resource");
});

test("a certificate id is a legal resource id", async () => {
  const { certIdFor } = await cert$;
  for (const host of ["acme.com", "a".repeat(200) + ".com", "sub.domain.example.co.uk"]) {
    const id = certIdFor(host);
    assert.ok(id.length <= 63, `${id.length} characters`);
    assert.match(id, /^[a-z][a-z0-9-]*$/);
  }
});

/* -------------------------------------------------------- certificate state */

test("a certificate that is provisioning and one that is stuck are not the same answer", async () => {
  const { readCertState } = await cert$;
  assert.deepEqual(readCertState({ managed: { state: "ACTIVE" } }), { state: "active" });

  // The one this reading exists for: Google sits in PROVISIONING both while it
  // has not looked yet and while it has looked and could not reach the domain.
  // Only the attempt info separates them, and only one of the two is something
  // the person can act on.
  const stuck = readCertState({
    managed: {
      state: "PROVISIONING",
      authorizationAttemptInfo: [{ state: "FAILED", failureReason: "CONFIG", details: "DNS points elsewhere" }],
    },
  });
  assert.equal(stuck.state, "provisioning");
  assert.equal((stuck as { detail: string }).detail, "DNS points elsewhere");

  const failed = readCertState({ managed: { state: "FAILED", provisioningIssue: { details: "domain not authorized" } } });
  assert.deepEqual(failed, { state: "failed", detail: "domain not authorized" });

  // A shape we do not recognise is "still working", never "live".
  assert.equal(readCertState({}).state, "provisioning");
  assert.equal(readCertState(null).state, "provisioning");
});

/* ----------------------------------------------------------- the reconcile */

const DOMAIN = {
  hostname: "shop.acme.com", slug: "lilna", status: "pending_dns" as const,
  certId: null, entryId: null, detail: null, checkedAt: null, createdAt: 0, liveAt: null,
};

function attachDeps(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      resolve4: async () => { calls.push("dns"); return ["8.233.7.157"]; },
      servesTls: async () => { calls.push("tls"); return true; },
      ensureCertificate: async () => { calls.push("cert"); return { ok: true as const, value: "cert-id" }; },
      ensureMapEntry: async () => { calls.push("entry"); return { ok: true as const, value: "entry-id" }; },
      certificateState: async () => { calls.push("state"); return { ok: true as const, value: { state: "active" as const } }; },
      record: async () => { calls.push("record"); },
      edgeIp: "8.233.7.157",
      now: () => 1_000,
      ...over,
    },
  };
}

test("a domain that does not point here yet is told where it points instead", async () => {
  const { reconcileDomain } = await attach$;
  const { deps, calls } = attachDeps({ resolve4: async () => ["203.0.113.9"] });
  const out = await reconcileDomain(DOMAIN, deps as never);
  assert.equal(out.status, "pending_dns");
  // The whole diagnosis: "not propagated yet" and "you pointed it somewhere
  // else" are indistinguishable from a spinner, and only one of them is a
  // mistake the person can fix.
  assert.match(out.detail ?? "", /203\.0\.113\.9/);
  assert.match(out.detail ?? "", /8\.233\.7\.157/);
  assert.deepEqual(calls, [], "nothing is created for a domain that does not resolve here");
});

test("a name with no record at all says so plainly", async () => {
  const { reconcileDomain } = await attach$;
  const { deps } = attachDeps({
    resolve4: async () => { throw Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" }); },
  });
  const out = await reconcileDomain(DOMAIN, deps as never);
  assert.equal(out.status, "pending_dns");
  assert.match(out.detail ?? "", /no DNS record/);
});

test("a domain in the middle of a migration still counts as pointing here", async () => {
  const { reconcileDomain } = await attach$;
  // Two A records, one of them the old host. Refusing to proceed until the old
  // one is gone would hold the certificate hostage to the cutover it exists to
  // make safe.
  const { deps } = attachDeps({ resolve4: async () => ["203.0.113.9", "8.233.7.157"] });
  assert.equal((await reconcileDomain(DOMAIN, deps as never)).status, "live");
});

test("the certificate is created, then put on the load balancer, then waited on", async () => {
  const { reconcileDomain } = await attach$;
  const { deps, calls } = attachDeps();
  const out = await reconcileDomain(DOMAIN, deps as never);
  // The order is forced: authorization is Google asking our load balancer for
  // this hostname, and it can only answer for one that is in its map.
  assert.deepEqual(calls, ["dns", "cert", "entry", "state", "tls"]);
  assert.deepEqual(out, { status: "live", detail: null, certId: "cert-id", entryId: "entry-id" });
});

test("a certificate still being issued is 'securing', with whatever Google said", async () => {
  const { reconcileDomain } = await attach$;
  const { deps } = attachDeps({
    certificateState: async () => ({ ok: true, value: { state: "provisioning", detail: "waiting on authorization" } }),
  });
  const out = await reconcileDomain(DOMAIN, deps as never);
  assert.equal(out.status, "securing");
  assert.equal(out.detail, "waiting on authorization");
});

test("Google refusing to issue is a state, not an exception", async () => {
  const { reconcileDomain } = await attach$;
  const { deps } = attachDeps({
    certificateState: async () => ({ ok: true, value: { state: "failed", detail: "domain not authorized" } }),
  });
  assert.deepEqual(await reconcileDomain(DOMAIN, deps as never), {
    status: "failed", detail: "domain not authorized", certId: "cert-id", entryId: "entry-id",
  });
});

test("a call we could not make leaves the domain retryable and says why", async () => {
  const { reconcileDomain } = await attach$;
  const { deps } = attachDeps({
    ensureCertificate: async () => ({ ok: false, why: "could not reach Certificate Manager" }),
  });
  const out = await reconcileDomain(DOMAIN, deps as never);
  // Not 'failed': nothing was refused. 'failed' is reserved for Google saying no,
  // because that is the only one of the two a person has to act on.
  assert.equal(out.status, "securing");
  assert.match(out.detail ?? "", /Certificate Manager/);
});

test("a live domain is never re-checked, and one that is not is", async () => {
  const { dueForCheck } = await attach$;
  assert.equal(dueForCheck({ ...DOMAIN, status: "live", checkedAt: 0 }, 10_000_000), false);
  assert.equal(dueForCheck({ ...DOMAIN, checkedAt: null }, 1_000), true);
  assert.equal(dueForCheck({ ...DOMAIN, checkedAt: 1_000 }, 2_000), false, "a polling page must not be a load generator");
  assert.equal(dueForCheck({ ...DOMAIN, checkedAt: 1_000 }, 60_000), true);
});

/* ---------------------------------------------------------------- the table */

test("attaching a hostname somebody else already has is a refusal, not a move", async () => {
  const { attachDomain } = await domains$;
  withDb(() => ({ rows: [{ hostname: "shop.acme.com", slug: "someone-else", status: "live", cert_id: null, entry_id: null, detail: null, checked_at: null, created_at: new Date(), live_at: null }], rowCount: 1 }));
  const out = await attachDomain("lilna", "shop.acme.com");
  assert.deepEqual(out, { ok: false, taken: true });
  assert.equal(sent.length, 1, "a taken hostname must not reach the INSERT");
});

test("attaching a hostname this app already has changes nothing", async () => {
  const { attachDomain } = await domains$;
  const row = { hostname: "shop.acme.com", slug: "lilna", status: "securing", cert_id: "c", entry_id: "e", detail: null, checked_at: null, created_at: new Date(), live_at: null };
  withDb(() => ({ rows: [row], rowCount: 1 }));
  const out = await attachDomain("lilna", "shop.acme.com");
  // The button somebody presses twice must not throw away a certificate that is
  // halfway issued.
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.domain.status, "securing");
  assert.equal(sent.length, 1);
});

test("the race the read cannot close is decided by the primary key", async () => {
  const { attachDomain } = await domains$;
  let first = true;
  withDb((sql) => {
    if (first) { first = false; return { rows: [], rowCount: 0 }; }   // nobody has it...
    throw Object.assign(new Error("duplicate key"), { code: "23505" }); // ...until the INSERT
  });
  assert.deepEqual(await attachDomain("lilna", "shop.acme.com"), { ok: false, taken: true });
});

/* ------------------------------------------------- creating, in the right order */

// The failure the first real domain hit. `POST /certificates` is a long-running
// operation: it is accepted, and the resource appears afterwards. The map entry
// created next names that certificate, so going straight there fails with
// `certificate "..." doesn't exist` — and the whole attach stalls a cycle. It
// did not show up in the first live test because the operation happened to
// finish inside the same few seconds. A race that usually loses is still a race.
test("the certificate is not reported ready until it can actually be read", async () => {
  const { ensureCertificate, setCertTransport, setCertSleep, certIdFor } = await cert$;
  setCertSleep(async () => {});
  const id = certIdFor("acme.com");
  const seen: string[] = [];
  let exists = false;
  setCertTransport(async (path, init) => {
    seen.push(`${init.method ?? "GET"} ${path.split("?")[0]}`);
    if (init.method === "POST") { return { status: 200, body: { name: "projects/p/locations/global/operations/op-1" } }; }
    if (path.startsWith("/operations/")) { exists = true; return { status: 200, body: { done: true } }; }
    return exists ? { status: 200, body: { managed: { state: "PROVISIONING" } } } : { status: 404, body: null };
  });
  try {
    const out = await ensureCertificate("acme.com");
    assert.equal(out.ok, true);
    // The operation is waited on BETWEEN the create and the read, which is the
    // whole of the fix.
    assert.deepEqual(seen, [`GET /certificates/${id}`, "POST /certificates", "GET /operations/op-1", `GET /certificates/${id}`]);
  } finally { setCertTransport(null); }
});

test("a certificate that never appears is retryable, not a failure", async () => {
  const { ensureCertificate, setCertTransport, setCertSleep } = await cert$;
  setCertSleep(async () => {});
  setCertTransport(async (path, init) => {
    if (init.method === "POST") return { status: 200, body: {} };
    return { status: 404, body: null };   // never shows up
  });
  try {
    const out = await ensureCertificate("acme.com");
    assert.equal(out.ok, false);
    // The reconcile turns this into `securing`, so the next look tries again —
    // rather than `failed`, which is reserved for Google refusing.
    assert.match(out.ok === false ? out.why : "", /keeps trying on its own/);
  } finally { setCertTransport(null); }
});

/* --------------------------------------------------- live means a browser agrees */

// What the first real domain taught: ACTIVE is Google saying the certificate
// exists, not the load balancer saying it will offer it. In between, a browser
// gets a dropped handshake, which to a person is indistinguishable from broken.
test("a certificate Google calls ACTIVE is not live until the edge serves it", async () => {
  const { reconcileDomain } = await attach$;
  const { deps } = attachDeps({ servesTls: async () => false });
  const out = await reconcileDomain(DOMAIN, deps as never);
  assert.equal(out.status, "securing");
  assert.match(out.detail ?? "", /still picking it up/);
});

test("a certificate covers a name, or it does not — never nearly", async () => {
  const { certCovers } = await attach$;
  assert.equal(certCovers("DNS:arsen.wtf", "arsen.wtf"), true);
  // The substring match this function exists to not be.
  assert.equal(certCovers("DNS:notarsen.wtf", "arsen.wtf"), false);
  assert.equal(certCovers("DNS:arsen.wtf.evil.com", "arsen.wtf"), false);
  // A wildcard covers one label under its own parent, and nothing else.
  assert.equal(certCovers("DNS:*.acme.com", "shop.acme.com"), true);
  assert.equal(certCovers("DNS:*.acme.com", "a.b.acme.com"), false);
  assert.equal(certCovers("DNS:*.acme.com", "acme.com"), false);
  assert.equal(certCovers("DNS:*.supersonic.cv", "arsen.wtf"), false);
  assert.equal(certCovers(undefined, "arsen.wtf"), false);
  // Several names, one of which matches, and case is not significant in DNS.
  assert.equal(certCovers("DNS:www.acme.com, DNS:Acme.com", "acme.com"), true);
});
