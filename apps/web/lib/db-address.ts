/**
 * Where Postgres answers, which is now a property of the runtime.
 *
 * Its own file rather than more of lanes.ts: that module is Cloud Run's
 * vocabulary — sidecars, startup probes, --set-env-vars — and this is the one
 * value both runtimes have to agree about. One declaration, with a test over it.
 */
export interface DbAddress {
  host: string;
  port: string;
}

/**
 * Cloud Run: a Cloud SQL Auth Proxy sidecar in the same service, on loopback.
 * See `dbContainerArgs`, which carries the account of what that cost to learn.
 */
export const CLOUD_RUN_DB: DbAddress = { host: "127.0.0.1", port: "5432" };

/**
 * The fleet: one proxy per node, on the sandbox bridge gateway.
 *
 * Not a new convention — `bridgeCIDR` in services/fleet/agent/network.go is
 * 10.200.0.1/16 and `SetupSandboxNet` gives every sandbox a default route via
 * it. Every app can reach this by construction.
 *
 * gVisor runs its own network stack, so this could NOT have been 127.0.0.1 with
 * a redirect: loopback inside a sandbox never leaves it, and no rule in the
 * namespace sees that traffic.
 */
export const FLEET_DB: DbAddress = { host: "10.200.0.1", port: "5432" };

/**
 * The connection URL, which is the one string every database-backed app depends
 * on and which had no test over it: it was built inline inside
 * `provisionPostgres`, a function that shells out to gcloud.
 *
 * The user and password are percent-encoded. A generated password containing
 * `@` moves the host, and the app then fails to resolve a hostname that is
 * really the tail of a password — a confusing error, and a password in a log.
 */
export function databaseUrlFor(
  role: { user: string; password: string },
  dbName: string,
  at: DbAddress,
): string {
  const user = encodeURIComponent(role.user);
  const password = encodeURIComponent(role.password);
  return `postgresql://${user}:${password}@${at.host}:${at.port}/${dbName}`;
}
