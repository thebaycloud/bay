import { test } from "node:test";
import assert from "node:assert/strict";
import { proxyWait, CLOUD_RUN_DB, FLEET_DB } from "../lib/db-address";

/**
 * Which address an app waits on before it starts.
 *
 * `proxyWait()` produces a shell prefix that polls the database proxy until it
 * answers, and `generateDockerfile` bakes it into the image's CMD — so it runs
 * on EVERY start of a database-backed app, not only on the deploy that built it:
 * restarts, rehoming after a node dies, rollbacks.
 *
 * Its default was `CLOUD_RUN_DB` — 127.0.0.1:5432, a Cloud SQL Auth Proxy
 * sidecar in the same Cloud Run service. There are no such sidecars: nothing
 * deploys to a per-app Cloud Run service, and an app with a database is a fleet
 * app by construction, because the static lane does not implement `uses` and so
 * cannot declare one.
 *
 * On the fleet the proxy is one per node on the sandbox bridge gateway,
 * 10.200.0.1:5432, and lib/db-address.ts says why it could not have been
 * loopback: gVisor runs its own network stack, so 127.0.0.1 inside a sandbox
 * never leaves it. The probe could not have succeeded — it ran its full timeout
 * on every start and then let the app run anyway, so the cost was thirty
 * seconds of silence and never an error anybody could see.
 */

test("the wait targets the fleet's proxy, which is the only proxy an app can reach", () => {
  const script = proxyWait();
  assert.ok(script.includes(FLEET_DB.host), `must probe ${FLEET_DB.host} — the node's proxy`);
  assert.ok(
    !script.includes(CLOUD_RUN_DB.host),
    `must not probe ${CLOUD_RUN_DB.host}: inside a gVisor sandbox loopback never leaves the sandbox, ` +
    `so this can only ever run out its timeout`,
  );
});

test("the two addresses are still different, or this test proves nothing", () => {
  // The assertion above is only meaningful while the fleet and Cloud Run
  // addresses differ. If they are ever unified, this test silently starts
  // passing for the wrong reason.
  assert.notEqual(FLEET_DB.host, CLOUD_RUN_DB.host);
});

test("an explicit address still wins, so a caller that knows better can say so", () => {
  const script = proxyWait("10.1.2.3", "6543");
  assert.ok(script.includes("10.1.2.3"));
  assert.ok(script.includes("6543"));
});

test("the wait is bounded, and gives up rather than blocking a start forever", () => {
  // A proxy that never answers must not become an app that never starts. The
  // loop counts and then falls through — which is also why the wrong address
  // cost thirty seconds instead of a failed deploy.
  const script = proxyWait(FLEET_DB.host, FLEET_DB.port, 7);
  assert.match(script, /i -lt 7/);
});
