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

/**
 * A bounded wait for the proxy to accept a connection, as POSIX sh.
 *
 * `--depends-on` orders container START, not port readiness (#13). Cloud Run
 * starts the proxy first and then starts this container; the proxy still has to
 * reach Cloud SQL and bind. A release command that connects at import time —
 * which is every `manage.py`, every Alembic `env.py` — can lose that race and
 * die on "connection refused" against a proxy that was listening 200ms later.
 * That failure is indistinguishable from a database that does not exist.
 *
 * It gives up quietly instead of failing. The app's own connection error names
 * the database and the port; a wait loop that turned a slow proxy into a task
 * timeout would replace a diagnosable failure with an undiagnosable one. The loop
 * itself is written without bash-isms because it runs inside the customer's own
 * image, whose /bin/sh is usually dash, and it probes for its tools rather than
 * assuming them for the same reason.
 *
 * TWO CHANGES FOR THE GENERATED-IMAGE WORLD
 *
 * This used to run for workers, crons and release jobs only — all of which are
 * Node or Python, because they were runner bundles. Prefixed to a WEB command in
 * a generated image it can now land on Go, Rust and Java, and none of those base
 * images has `nc`, `python3` or `node`.
 *
 * So, first: a fourth probe. `bash` is present in every Debian- and Ubuntu-based
 * official language image — which is all of them, since dockerfile.ts ships the
 * full base rather than `-slim` — and `/dev/tcp` needs nothing else installed.
 * It is invoked through `bash -c` rather than used inline, because Debian's
 * `/bin/sh` is dash and would fail the redirect even where bash exists.
 *
 * Second, and this is the one that was costing real time: the loop had no early
 * exit for "none of these tools is here". It ran the full count, sleeping one
 * second per iteration, and then fell through — a silent 30-second penalty on
 * every cold start of every container that could not probe at all. Availability
 * is now checked once, before the loop, so an image with no probe waits zero
 * seconds instead of thirty and the app's own connect error arrives immediately.
 *
 * Third, and this one cost the whole timeout on every start: the DEFAULT ADDRESS
 * was Cloud Run's — 127.0.0.1:5432, a Cloud SQL Auth Proxy sidecar in the same
 * service. There are no such sidecars. Nothing deploys to a per-app Cloud Run
 * service, and an app with a database is a fleet app by construction: the static
 * lane does not implement `uses`, so it cannot declare one.
 *
 * On a node the proxy is one per machine on the sandbox bridge gateway, and
 * db-address.ts states why it could not have been loopback — gVisor runs its own
 * network stack, so 127.0.0.1 inside a sandbox never leaves the sandbox. The
 * probe was unreachable BY CONSTRUCTION, ran its full count, and let the app
 * start anyway. Thirty seconds of silence on every start of every
 * database-backed app: deploys, restarts, rehoming after a node dies, rollbacks.
 * Never an error, because falling through is what the loop is supposed to do.
 *
 * The default is `FLEET_DB` now. A caller with a different address still passes
 * one; there is simply no longer a runtime whose address is the old default.
 */
export function proxyWait(host = FLEET_DB.host, port = FLEET_DB.port, seconds = 30): string {
  const tools = ["nc", "python3", "node", "bash"];
  const probe = [
    `command -v nc >/dev/null 2>&1 && nc -z ${host} ${port} >/dev/null 2>&1`,
    `command -v python3 >/dev/null 2>&1 && python3 -c 'import socket,sys;s=socket.socket();s.settimeout(1);sys.exit(s.connect_ex(("${host}",${port})))' >/dev/null 2>&1`,
    `command -v node >/dev/null 2>&1 && node -e 'const s=require("net").connect(${port},"${host}");s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),1000)' >/dev/null 2>&1`,
    `command -v bash >/dev/null 2>&1 && bash -c 'exec 3<>/dev/tcp/${host}/${port}' >/dev/null 2>&1`,
  ].map((c) => `{ ${c}; }`).join(" || ");
  const available = tools.map((t) => `command -v ${t} >/dev/null 2>&1`).join(" || ");
  return `if ${available}; then i=0; while [ $i -lt ${seconds} ]; do if ${probe}; then break; fi; i=$((i+1)); sleep 1; done; fi; `;
}
