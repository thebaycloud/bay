import { test } from "node:test";
import assert from "node:assert/strict";
import { rootDomain, productName, appHost, controlPlaneHost, _brandForTesting } from "../lib/brand";

/**
 * The two words the platform is named by.
 *
 * This module exists so a rename is a configuration change rather than a
 * find-and-replace across 374 files. Everything asserted here is about that one
 * property: the values come from the environment, the defaults are today's, and
 * there is exactly ONE answer to "what domain are we" no matter who asks.
 *
 * That last part is the bug this replaces. `lib/app-urls.ts` read
 * NEXT_PUBLIC_ROOT_DOMAIN and `lib/cors.ts` read ROOT_DOMAIN, both defaulting
 * to the same literal — so setting one and not the other produced a platform
 * that built links for one domain and refused requests from it.
 */

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    _brandForTesting.reset();
  }
}

const NONE = { NEXT_PUBLIC_ROOT_DOMAIN: undefined, ROOT_DOMAIN: undefined, NEXT_PUBLIC_PRODUCT_NAME: undefined };

test("today's values are the defaults, so nothing changes until something is set", () => {
  withEnv(NONE, () => {
    assert.equal(rootDomain(), "supersonic.cv");
    assert.equal(productName(), "Supersonic");
  });
});

test("the public variable wins, because a client bundle can read only that one", () => {
  // Next inlines NEXT_PUBLIC_* at build time and strips everything else from the
  // browser bundle. If the server preferred ROOT_DOMAIN, the same function would
  // answer two different things depending on where it ran.
  withEnv({ ...NONE, NEXT_PUBLIC_ROOT_DOMAIN: "thebay.cloud", ROOT_DOMAIN: "supersonic.cv" }, () => {
    assert.equal(rootDomain(), "thebay.cloud");
  });
});

test("the server-only variable still works alone, for processes Next never built", () => {
  // The proxy, the deploy job and the fleet agent are not Next builds and have
  // no NEXT_PUBLIC_ anything.
  withEnv({ ...NONE, ROOT_DOMAIN: "thebay.cloud" }, () => {
    assert.equal(rootDomain(), "thebay.cloud");
  });
});

test("hosts are built from the one answer, never from a literal", () => {
  withEnv({ ...NONE, ROOT_DOMAIN: "thebay.cloud" }, () => {
    assert.equal(appHost("l3sgp"), "l3sgp.thebay.cloud");
    assert.equal(controlPlaneHost(), "app.thebay.cloud");
  });
});

test("the product name is separate from the domain, because they rename apart", () => {
  withEnv({ ...NONE, ROOT_DOMAIN: "thebay.cloud", NEXT_PUBLIC_PRODUCT_NAME: "Bay" }, () => {
    assert.equal(productName(), "Bay");
    assert.equal(rootDomain(), "thebay.cloud");
  });
});

test("whitespace and a stray protocol do not become part of the domain", () => {
  // These get set by hand, in a dashboard, by somebody in a hurry. A leading
  // https:// silently produces https://https://app.… and a trailing space
  // produces a hostname no DNS will answer.
  for (const raw of ["  thebay.cloud  ", "https://thebay.cloud", "thebay.cloud/", "HTTPS://TheBay.Cloud"]) {
    withEnv({ ...NONE, ROOT_DOMAIN: raw }, () => {
      assert.equal(rootDomain(), "thebay.cloud", `not cleaned: ${JSON.stringify(raw)}`);
    });
  }
});

test("an empty value is not a domain and falls back rather than building https://.", () => {
  withEnv({ ...NONE, ROOT_DOMAIN: "   " }, () => {
    assert.equal(rootDomain(), "supersonic.cv");
  });
});
