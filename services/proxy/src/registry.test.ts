import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { lookupWith, resetRegistry, registryStaleFor, type AppRow, type RegistryDeps } from "./registry";

function row(slug: string, over: Partial<AppRow> = {}): AppRow {
  return {
    id: "id-" + slug, slug, workspace_id: "w", owner_id: "o", owner_email: "a@b.c",
    owner_plan: null, owner_status: null, run_url: "https://" + slug + ".run.app",
    visibility: "public", status: "live", deploy: null, routes: null, has_web: true,
    umami_website_id: null, analytics_enabled: true,
    ...over,
  };
}

/** A clock the test drives, and a fetcher whose behaviour the test decides. */
function deps(over: Partial<RegistryDeps> = {}): RegistryDeps & { lines: string[]; calls: number } {
  const lines: string[] = [];
  const d = {
    lines, calls: 0,
    fetchApp: async (slug: string) => { d.calls++; return row(slug); },
    now: () => 1_000_000,
    log: (l: string) => { lines.push(l); },
    ...over,
  } as RegistryDeps & { lines: string[]; calls: number };
  return d;
}

beforeEach(() => resetRegistry());

test("a fresh lookup asks the database and caches the answer", async () => {
  const d = deps();
  assert.equal((await lookupWith(d, "lilna"))?.slug, "lilna");
  assert.equal((await lookupWith(d, "lilna"))?.slug, "lilna");
  assert.equal(d.calls, 1, "the second lookup inside the window must not query");
});

test("a row mid-deploy is cached for barely any time at all", async () => {
  let t = 1_000_000;
  const d = deps({
    fetchApp: async (slug: string) => { d.calls++; return row(slug, { status: "deploying" }); },
    now: () => t,
  });
  await lookupWith(d, "lilna");
  t += 2_500;                       // past CACHE_MS_DEPLOYING, far short of CACHE_MS
  await lookupWith(d, "lilna");
  assert.equal(d.calls, 2, "a deploying row must not go stale for the full window");
});

// The failure this whole change exists for. Railway, 19 May 2026: the edge held
// routing state behind a cache, the control plane went away, the caches expired,
// and every region went dark regardless of where its apps were running.
test("a database that cannot answer serves the last row we knew", async () => {
  let t = 1_000_000;
  let broken = false;
  const d = deps({
    fetchApp: async (slug: string) => {
      d.calls++;
      if (broken) throw new Error("ECONNREFUSED");
      return row(slug);
    },
    now: () => t,
  });

  assert.equal((await lookupWith(d, "lilna"))?.slug, "lilna");

  broken = true;
  t += 60_000;                      // well past the ordinary cache window
  const served = await lookupWith(d, "lilna");
  assert.equal(served?.slug, "lilna", "the app must keep resolving while the database is away");
});

// The other half, and it must NOT be symmetrical. Inventing an app we have never
// resolved would answer for a slug that may not exist, and a stranger walking
// subdomains would be the one deciding what we serve.
test("a slug we never resolved still fails when the database is away", async () => {
  const d = deps({ fetchApp: async () => { throw new Error("ECONNREFUSED"); } });
  await assert.rejects(() => lookupWith(d, "never-seen"), /ECONNREFUSED/);
});

// Absence is a fact we learned, so it survives the outage exactly as presence
// does — an app that did not exist a minute ago still does not.
test("a slug we resolved to nothing keeps resolving to nothing", async () => {
  let broken = false;
  const d = deps({
    fetchApp: async () => { if (broken) throw new Error("ECONNREFUSED"); return null; },
    now: () => 1_000_000,
  });
  assert.equal(await lookupWith(d, "gone"), null);
  broken = true;
  assert.equal(await lookupWith(d, "gone"), null);
});

test("serving from a stale snapshot is said once, not once per request", async () => {
  let t = 1_000_000;
  let broken = false;
  const d = deps({
    fetchApp: async (slug: string) => { if (broken) throw new Error("ECONNREFUSED"); return row(slug); },
    now: () => t,
  });
  await lookupWith(d, "a");
  await lookupWith(d, "b");

  broken = true;
  t += 60_000;
  for (let i = 0; i < 5; i++) { await lookupWith(d, "a"); await lookupWith(d, "b"); }

  const entered = d.lines.filter((l) => /serving from the last known state/.test(l));
  assert.equal(entered.length, 1, "an outage must not also be a log flood");
});

test("staleness is a number the health check can read, and it clears on recovery", async () => {
  let t = 1_000_000;
  let broken = false;
  const d = deps({
    fetchApp: async (slug: string) => { if (broken) throw new Error("ECONNREFUSED"); return row(slug); },
    now: () => t,
  });
  await lookupWith(d, "lilna");
  assert.equal(registryStaleFor(t), null, "a healthy edge reports no staleness");

  broken = true;
  t += 60_000;
  await lookupWith(d, "lilna");
  assert.equal(registryStaleFor(t + 5_000), 5_000, "staleness is measured from the first failure");

  broken = false;
  t += 10_000;
  await lookupWith(d, "lilna");
  assert.equal(registryStaleFor(t), null, "recovery must clear it, or it reads as a permanent outage");
  assert.ok(d.lines.some((l) => /database is answering again/.test(l)));
});

// Cache keys come from the Host header, so the key space belongs to strangers.
// The fallback map has to be bounded for the same reason the cache is.
test("the last-known map is bounded, so walking subdomains costs a stranger memory and not us", async () => {
  const d = deps();
  for (let i = 0; i < 1_200; i++) await lookupWith(d, `s${i}`);

  const broken = deps({ fetchApp: async () => { throw new Error("ECONNREFUSED"); }, now: () => 1_000_000 });
  // The oldest entries were evicted; the newest survive.
  assert.equal((await lookupWith(broken, "s1199"))?.slug, "s1199");
  await assert.rejects(() => lookupWith(broken, "s0"), /ECONNREFUSED/);
});
