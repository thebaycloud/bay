import { test } from "node:test";
import assert from "node:assert/strict";
import { productName, appHost, controlPlaneHost, _brandForTesting } from "../lib/brand";

/**
 * What the platform is CALLED.
 *
 * The domain half of this module was deleted when lib/roots.ts landed on main
 * doing it better — a list with the canonical root first, rather than a single
 * value. Two answers to "what domain are we" is the exact defect roots.ts
 * exists to prevent, so what is left here is the other fact: the name, and the
 * two hosts built from the canonical root.
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

const NONE = { NEXT_PUBLIC_PRODUCT_NAME: undefined, PRODUCT_NAME: undefined };

test("today's name is the default, so nothing moves until something is set", () => {
  withEnv(NONE, () => assert.equal(productName(), "Supersonic"));
});

test("the public variable wins, because a client bundle can read only that one", () => {
  // Next inlines NEXT_PUBLIC_* at build time and strips the rest from the
  // browser bundle. Preferring the server-only name would put the old brand on
  // a page while the server used the new one.
  withEnv({ NEXT_PUBLIC_PRODUCT_NAME: "Bay", PRODUCT_NAME: "Supersonic" }, () => {
    assert.equal(productName(), "Bay");
  });
});

test("the server-only variable still works alone, for processes Next never built", () => {
  withEnv({ ...NONE, PRODUCT_NAME: "Bay" }, () => assert.equal(productName(), "Bay"));
});

test("an empty value is not a name", () => {
  withEnv({ ...NONE, PRODUCT_NAME: "   " }, () => assert.equal(productName(), "Supersonic"));
});

test("hosts are built from the canonical root, never from a literal", () => {
  withEnv({ ...NONE, NEXT_PUBLIC_ROOT_DOMAINS: "thebay.cloud,supersonic.cv" }, () => {
    assert.equal(appHost("l3sgp"), "l3sgp.thebay.cloud");
    assert.equal(controlPlaneHost(), "app.thebay.cloud");
  });
});

test("a second root does not become the one addresses are minted under", () => {
  // ORDER IS MEANING in roots.ts. If this ever reads the wrong end of the list,
  // people are told to point their own DNS at a name being retired.
  withEnv({ ...NONE, NEXT_PUBLIC_ROOT_DOMAINS: "thebay.cloud,supersonic.cv" }, () => {
    assert.ok(!appHost("x").endsWith("supersonic.cv"));
  });
});
