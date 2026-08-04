# The fleet becomes a deploy target, databases included

**Date:** 2026-08-04
**Status:** approved, not implemented
**Piece 1 of 7** — see "The order" at the end.

## The decision

Every app the fleet can serve stops being deployed to Cloud Run. Not additively —
the pipeline chooses a runtime *before* it deploys and takes one branch. Apps
with a database reach Postgres through one Cloud SQL Auth Proxy per node,
listening on the sandbox bridge gateway.

After this piece that means every container- and buildpack-lane app with a web
process, database or not. Static, runner-lane and worker-only apps keep going to
Cloud Run until pieces 2–4 move them.

There is no way back to Cloud Run for an app. That was a choice, not an
oversight: two live runtimes is where this week's defects came from, and keeping
a reverse gear means keeping both.

## Scope

**In:** the node-side proxy, the pipeline's runtime fork, `DATABASE_URL` in one
form, the failure path without a Cloud Run fallback, and one real database-backed
app proven end to end.

**Out:** scheduled and background processes on the fleet (piece 2), static apps
(3), the runner lane (4), HTTPS (5), a second node (6), deleting the Cloud Run
code (7).

## Why the additive shape cannot survive this

The pipeline today deploys to Cloud Run, verifies there, and only then attempts a
placement on the fleet. That shape was deliberate — it is how placement was
introduced without risking anything — and it stops working the moment a database
is involved.

`DATABASE_URL` on the fleet must name an address the node can reach. A Cloud Run
revision cannot reach it. So a database-backed app under the additive shape fails
its *first* step, on the runtime it is leaving, for a reason belonging to the
runtime it is going to.

Hence the fork:

```
build image → choose runtime → ┬─ fleet:     place → verify through the LB
                               └─ cloud run: deploy → verify at the service URL
```

## Design

### The proxy

One `cloud-sql-proxy` per node, as a systemd unit installed by
`services/fleet/image/provision.sh`, ordered before the agent and restarted on
failure.

It listens on **`10.200.0.1:5432`**. That address is not a new convention — it is
the sandbox bridge (`ssbr0`, `bridgeCIDR = 10.200.0.1/16`), and
`SetupSandboxNet` already gives every sandbox `ip route add default via
10.200.0.1`. Every app can reach it by construction, with no per-app plumbing.

It authenticates as the node's service account, which already holds
`cloudsql.client`. This is why the proxy runs on the **host** and not per app:
`provision.sh` blocks the metadata server from tenant traffic on purpose, so a
proxy inside a sandbox has no way to obtain a credential. Per-app proxies are not
merely more expensive here — they are ruled out by the isolation design.

Nothing about the Cloud SQL instance changes. It keeps only its public IP
(`35.255.219.41`), no private IP, and an empty authorized-networks list; the
proxy dials out over TLS rather than anything dialling in.

### The pipeline's runtime fork

`chooseRuntime` decides before any deploy happens, from what the app is:
container or buildpack lane, has an image, has a web process. The fleet is the
default for everything it can serve; the Cloud Run branch stays reachable for the
kinds it cannot yet, until pieces 2–4 remove them:

- **static** — no image of its own to run.
- **runner lane** — the image is shared and the app's code is not in it.
- **worker-only** — the fleet runs these perfectly well; what is missing is the
  CHECK. The only proof this pipeline accepts is an HTTP answer through the load
  balancer, and a worker publishes no route to ask. Piece 2 gives it one.

`fleetPlacementWanted` — the `FLEET_APPS` / `FLEET_PLACEMENT` pair added on
2026-08-04 — survives this piece and inverts at the end of it. It exists to move
one app before the default moves, which is exactly what a fork like this needs
during rollout. Once a database-backed app has been proven end to end, the fleet
becomes the default and the flags are deleted rather than left defaulting to
true: a flag nobody can turn off is a branch pretending to be a choice.

The `fleetEligibility` refusal added on 2026-08-04 — *"its database is reached
through a sidecar proxy the fleet has no equivalent for"* — is deleted here. It
was a guard for exactly this gap and outlives its purpose the moment the proxy
exists.

### One connection string

`provisionPostgres` writes `postgresql://user:pass@HOST:PORT/db`, where `HOST`
and `PORT` come from `lib/lanes.ts` (`DB_HOST = 127.0.0.1`, `DB_PORT = 5432`).
The fleet form is `10.200.0.1:5432`.

There is one form because there is one runtime. The alternative — a per-runtime
value — was rejected: the secret is read by the app, so a value that depends on
where the app happens to be running is a value that is wrong immediately after
anything moves.

The address cannot be made identical on both sides. Rewriting `127.0.0.1` inside
the sandbox does not work: gVisor runs its own network stack, so loopback inside
a sandbox never leaves it, and no nftables rule in the namespace sees that
traffic.

Existing apps' secrets are not migrated. They are test apps and they are deleted
in piece 7.

### Failure, without a fallback

Today a failed placement calls `setRuntime(slug, 'cloudrun')`. That disappears.

A deploy whose new version does not answer leaves **the previous placement
serving**, marks the deploy failed, and hands it to the repair agent exactly as a
failed Cloud Run deploy is handled now. The order that makes this safe is
unchanged and non-negotiable: place, verify, then route. A version that has not
answered never receives traffic.

### What is deleted here, and what is not

The rule is that a capability and the code it replaces travel together, so no
single terrifying deletion is ever required.

In this piece that yields very little, and it is worth being exact rather than
encouraging. "Deploy a Cloud Run service" is shared by ordinary apps *and* the
runner lane, and `dbContainerArgs`' sidecar is needed while any database-backed
app still deploys to Cloud Run. So what goes here is the temporary eligibility
refusal and the additive placement shape. The large deletions — `services/runner`,
`SUPERSONIC_CODE_KEY`, bundle encryption, domain mappings, `grantInvokers`,
`SEAL_APPS`, and all of `process-deploy.ts` — belong to pieces 4 and 7.

## Verification

Three levels, none of which substitutes for another.

**Pure functions, in tests.** Runtime choice, connection-string construction, and
the "did the app answer or did the router" verdict are decided without a node, a
database or a load balancer — the shape `fleet-place.ts` already uses.

**The proxy, on a live node, before any pipeline work.** Start the unit, enter a
sandbox's namespace, connect to Postgres by hand. If that does not work there is
no point continuing. A measurement, not an argument.

**One database-backed app, end to end.** Deployed from nothing, writing and
reading, answering through the load balancer, with data surviving a restart.

One requirement follows from what the dashboard got wrong: **the probe must
request a path that touches the database.** A 200 at the root proves the process
started. `epvmx` proved that a started process can refuse every real request, and
an app whose database is unreachable will serve its homepage happily.

## Done when

1. The proxy runs as a systemd unit on every node, before the agent, and survives
   a reboot.
2. The pipeline chooses a runtime before deploying and takes one branch.
3. `DATABASE_URL` is generated in one form; the database refusal is gone.
4. A failed verification leaves the previous placement serving and never falls
   back to Cloud Run.
5. A real database-backed app is deployed from scratch onto the fleet, reads and
   writes, and is verified by a probe that touches the database.
6. The fleet is the default for every kind it can serve, and `FLEET_APPS` /
   `FLEET_PLACEMENT` are gone rather than left switched on.

## Risks, stated rather than solved

- **One proxy process, many apps.** Unmeasured. Twenty apps on the node today, so
  it is not urgent, and it is not answered either.
- **A dead proxy must not read as a broken app.** The agent has to distinguish
  "the database path is down" from "this app is failing", or the repair agent
  edits a customer's repository over our own fault — at roughly $12–15 a run.
- **Connection limits on the shared instance.** The proxy does not pool, so this
  is no worse than today, and no better. Worth a number before app counts grow.
- **`10.200.0.1` becomes load-bearing.** It is currently a detail inside
  `network.go`; after this it is part of every database-backed app's
  configuration, and changing it silently breaks all of them.

## The order

| | |
|---|---|
| 1 | The fleet as a deploy target, databases included — *this spec* |
| 2 | Scheduled and background processes on the fleet |
| 3 | Static apps |
| 4 | Deleting the runner lane |
| 5 | HTTPS and the DNS cutover |
| 6 | A second node |
| 7 | Deleting the Cloud Run code |

The endpoint is that no Cloud Run deploy path exists in the repository. Deletion
follows capability rather than preceding it: removing a branch before the fleet
can serve the apps that use it leaves those apps with nowhere to go.
