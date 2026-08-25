import { test, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * That the reconcile job actually sweeps the limiter's table.
 *
 * Asserted against the route rather than against lib/rate-limit, because the
 * thing that can silently stop being true is the CALL, not the DELETE. The
 * statement itself is covered in test/rate-limit.test.ts against the real
 * module; here the only question is whether anything still invokes it — a sweep
 * nobody calls and a sweep that does not exist fail identically, and the table
 * grows without bound in both cases.
 */
process.env.FLEET_TOKEN = "test-fleet-token";

let sweeps = 0;
let sweepThrows = false;

mock.module("@/lib/rate-limit", {
  namedExports: {
    sweepOldWindows: async () => {
      sweeps++;
      // The real one swallows its own errors and returns 0. This asserts the
      // CALLER does not depend on that promise being kept, so a future edit to
      // rate-limit.ts that lets an error escape cannot silently break the
      // domain reconciliation it shares a request with.
      if (sweepThrows) throw new Error("connection terminated");
      return 7;
    },
  },
});

mock.module("@/lib/domains", {
  namedExports: { unsettledDomains: async () => [] },
});

mock.module("@/lib/domain-attach", {
  namedExports: { reconcileAll: async (rows: unknown[]) => rows },
});

// Deferred, not static: tsx compiles to CJS, where a static import would hoist
// above the mocks above and load the real modules.
const route$ = import("@/app/api/domains/reconcile/route");

function post(token = "test-fleet-token"): Request {
  return new Request("https://app.thebay.cloud/api/domains/reconcile", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

test("a reconcile pass sweeps the limiter's expired windows", async () => {
  const { POST } = await route$;
  sweeps = 0;
  sweepThrows = false;
  const res = await POST(post());
  assert.equal(res.status, 200);
  assert.equal(sweeps, 1);
  const body = (await res.json()) as { swept?: number };
  // Reported rather than silent, so an operator can see the sweep running
  // instead of assuming it. A number nobody can read is a number nobody
  // notices has been zero for a month.
  assert.equal(body.swept, 7);
});

test("an unauthorised caller sweeps nothing", async () => {
  const { POST } = await route$;
  sweeps = 0;
  const res = await POST(post("wrong"));
  assert.equal(res.status, 401);
  assert.equal(sweeps, 0);
});

test("a throwing sweep does not take the domain reconcile down", async () => {
  const { POST } = await route$;
  sweeps = 0;
  sweepThrows = true;
  const res = await POST(post());
  assert.equal(res.status, 200);
  assert.equal(sweeps, 1);
  sweepThrows = false;
});
