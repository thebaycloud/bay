import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TENANT_PG_INSTANCE,
  tenantConnectionName,
  platformConnectionName,
} from "../lib/pg-config";

/**
 * WHICH SERVER a tenant operation talks to.
 *
 * On 12 Aug the platform's own database moved to its own instance
 * (`supersonic-platform-pg`) and the tenant databases stayed on
 * `supersonic-shared-pg`. The move was done by flipping ONE environment
 * variable, `PG_CONN`, and the code was never told there were now two servers:
 * `pgConfig()` returned a single connection name and `getPool()` used it for
 * every database, tenant and platform alike.
 *
 * What that cost, measured on 16 Aug:
 *
 *   - `deleteApp` ran `DROP DATABASE <tenant>` against the PLATFORM instance,
 *     where no such database exists. The statement failed, the failure was
 *     tolerated by design, and then the verification query — `SELECT 1 FROM
 *     pg_database WHERE datname = $1` — ran on that SAME wrong instance, found
 *     nothing, and reported `dropped: true`. Fifteen customers' databases were
 *     still on the shared instance after the platform reported them deleted.
 *
 *   - `ensureAppRole` opened its pool on the platform instance, could not reach
 *     the tenant database, and fell back to the SHARED superuser credential —
 *     the exact hole `pg-role.ts` exists to close. Five of those fifteen
 *     databases were owned by `cloudsqlsuperuser` rather than by an `app_*`
 *     role, which is that fallback, visible in the catalogue.
 *
 * The bug is not that a name was wrong. It is that ONE name answered TWO
 * questions, so no wrongness was expressible. These tests pin the two apart.
 */

test("the tenant instance and the platform instance are not the same server", () => {
  // The whole defect in one line. Before the split these were equal and every
  // path worked by accident; after it they differ and every tenant path broke
  // silently. Neither state is detectable from a single connection name.
  assert.notEqual(
    tenantConnectionName(),
    platformConnectionName(),
    "tenant work and platform work must not share one connection name",
  );
});

test("the instance we CREATE tenant databases on is the instance we CONNECT to", () => {
  // This is the assertion that would have caught 16 Aug before it shipped.
  //
  // `provisionPostgres` creates a database with
  // `gcloud sql databases create --instance=<X>`, and `ensureAppRole` then
  // connects to that database to give it its own role. Those were two separate
  // literals: the gcloud call named `supersonic-shared-pg` while the connection
  // followed `PG_CONN`, which by then named `supersonic-platform-pg`. Creating
  // on one server and connecting to another cannot work, and nothing said so.
  //
  // One constant now answers both, so they cannot drift apart again.
  assert.ok(
    tenantConnectionName().endsWith(`:${TENANT_PG_INSTANCE}`),
    `the tenant connection must name ${TENANT_PG_INSTANCE}, the instance tenant databases are created on`,
  );
});

test("a connection name is project:region:instance", () => {
  // Cloud SQL's own spelling, and the shape both the proxy and the Unix socket
  // path are built from. A malformed one fails at connect time with a message
  // about the socket, which reads like a permissions problem and is not.
  const parts = tenantConnectionName().split(":");
  assert.equal(parts.length, 3, "expected project:region:instance");
  assert.ok(parts.every((p) => p.length > 0), "no empty segment");
});

test("PG_CONN names the PLATFORM instance, and does not move tenant work with it", () => {
  // PG_CONN was flipped to the platform instance on 12 Aug and that flip is
  // correct — the control plane's own database really did move. What was wrong
  // was that tenant work followed it. Setting PG_CONN must change where the
  // platform's tables are read and NOTHING about where tenant databases live.
  const before = tenantConnectionName();
  const saved = process.env.PG_CONN;
  try {
    process.env.PG_CONN = "some-project:some-region:some-other-instance";
    assert.equal(
      tenantConnectionName(),
      before,
      "tenant databases must not move because the platform's database moved",
    );
    assert.equal(
      platformConnectionName(),
      "some-project:some-region:some-other-instance",
      "the platform connection is the one PG_CONN names",
    );
  } finally {
    if (saved === undefined) delete process.env.PG_CONN;
    else process.env.PG_CONN = saved;
  }
});
