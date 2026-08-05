# The fleet

Apps run on machines we own. The plan is [`docs/VM-FLEET.md`](../../docs/VM-FLEET.md);
this is what exists and how to work on it.

Cloud Run is unchanged and still serves every app. The fleet runs alongside it,
one app at a time, decided by `apps.runtime`.

```
                        ┌─ Certificate Manager wildcard (not wired: DNS is at Namecheap)
   internet ── GCLB ────┤
                 │      └─ 8.232.255.172  (fleet-ip, HTTP today)
                 ▼
        ┌────────────────────────────────────────────┐
        │ node: supersonicd                          │
        │   router  :8080   Host → slug → 10.200.x.y │
        │   agent   reconcile loop, pull-only        │
        │   containerd  images + snapshots           │
        │   runsc       one gVisor sandbox per app   │
        └────────────────────────────────────────────┘
                 ▲
                 │ POST /api/fleet/sync   (register + heartbeat + desired state)
        control plane ── Postgres: apps.runtime, fleet_nodes, fleet_placements
```

## What is here

| Path | What it is |
|---|---|
| `image/provision.sh` | Everything that goes into a node image. Idempotent; safe to re-run on a live node. |
| `agent/` | `supersonicd` — the reconcile loop, the sandbox lifecycle, the router. Go, one static binary. |
| `fleetctl.sh` | Move one app between runtimes. The cutover tool. |
| `bench/` | The scripts behind every number in the plan's "Measured" section. |

## The agent

One loop: read desired state, compare to what is running, make the difference go
away. Everything else serves that loop.

- **It pulls, and caches.** Nothing pushes to a node. A control plane that is
  down cannot take running apps with it, and a node that reboots while it is
  unreachable comes back from `/srv/state/desired.cache.json`.
- **It drives `runsc` directly** and uses containerd only for images and
  snapshots — see "The shim" below.
- **Starts are concurrent, bounded at 8**, and each app is published to the
  routing table the moment it serves. Serially, 25 apps took minutes and the
  routing table stayed empty the whole time while the apps were up.
- **Health is on its own clock**, so how fast the router learns an app is sick
  does not depend on how long it takes to start fifty others.

## Running one

```bash
# provision a node (idempotent)
gcloud compute scp services/fleet/image/provision.sh <node>:/tmp/ --zone us-central1-a
gcloud compute ssh <node> --zone us-central1-a --command 'sudo bash /tmp/provision.sh'

# build + restart the agent after an edit
gcloud compute scp services/fleet/agent/*.go <node>:/opt/agent/ --zone us-central1-a
gcloud compute ssh <node> --zone us-central1-a --command 'sudo bash /tmp/restart-agent.sh'

# move an app onto the fleet, and back
bash services/fleet/fleetctl.sh place <slug>
bash services/fleet/fleetctl.sh unplace <slug>
bash services/fleet/fleetctl.sh nodes
```

`fleetctl` needs psql and a `cloud-sql-proxy` on `127.0.0.1:5432`. Running it
from a node is easiest — that is where both already are.

## Things that will bite you

**`pkill -f` from an ssh command kills the ssh command.** The pattern matches the
remote shell's own command line. This dropped four sessions before it was
obvious. Every process match in these scripts is `-x`, on the exact comm.

**The metadata server is also the DNS resolver.** Blocking `169.254.169.254`
wholesale takes DNS out on the whole node and in every sandbox. The nftables
rules block port 80 (the credentials API) and leave port 53 open. There is no
GCE-side way to do this — VPC firewall rules do not apply to metadata traffic.

**A sandbox needs its own network namespace.** runsc's netstack claims the
interfaces in whatever namespace it is given, so the host's namespace means
reaching for the host's NIC. The agent builds a namespace, a veth pair and an
address before the sandbox exists, and hands runsc the namespace **path** — the
name gets you `no such file or directory`, which reads like it was never created.

**Measure `memory.current`, not RSS.** Summing RSS across `runsc-*` processes
reports ~435 MB for one app because the sentry's `memfd` is counted every time it
appears. The real number is ~64–76 MB. Anything reading this fleet by RSS is
wrong by about 7×.

**`exec.Command` pipes and detached sandboxes deadlock.** The pipe waits for EOF;
a detached sandbox inherits the write end and holds it for its whole life. The
agent blocks forever on a call that already succeeded. `runscDetached` wires
stdio to the app's log file instead, which is where it had to go anyway.

**runsc writes warnings to stderr.** `CombinedOutput` makes `runsc state`
unparseable, so the agent concludes a serving app is dead.

## The shim

The agent does not use `io.containerd.runsc.v1`, and that was not the plan.

On containerd 2.2.6 **and** 1.7.29, with gVisor release-20260727.0, every
container started through the shim boots its sandbox, reaches `created`, and
never reaches `running`. The shim sits idle in epoll over a healthy gofer and
boot process; containerd's Start never returns; 40 seconds later it reports
`failed to delete task: context deadline exceeded`. The same image runs under
runc through the same containerd, and `runsc start` on the identical bundle
succeeds by hand in 20 milliseconds with exit 0. Both a dedicated network
namespace and the host's behave the same way.

`bench/debug-runsc.sh` reproduces it. The agent has to own supervision, cgroups,
namespaces and lifecycle regardless, so the shim was duplicating a supervisor we
were going to write — and it was the only part of the stack that did not work.

## Security posture

- Apps get **no GCP identity**. There is no metadata server for them to ask,
  which closes the `APP_RUNTIME_SERVICE_ACCOUNT`-is-unset hole `docs/CUTOVER.md`
  defers.
- The node runs as `supersonic-fleet-node@`, holding four roles:
  `artifactregistry.reader`, `cloudsql.client`, `logging.logWriter`, and
  `secretmanager.secretAccessor` **conditioned to `app-*` secrets only** — so a
  node cannot read platform secrets.
- Secrets are resolved at start and passed in the process environment. They are
  never written to node disk, never logged, and never placed in `config.json`,
  which is readable inside the sandbox. A secret that cannot be resolved fails
  the start, because an app that comes up without its `DATABASE_URL` fails every
  request and still passes a health check on `/`.
- `FLEET_TOKEN` is a shared secret compared in constant time, and the endpoint
  refuses to work when it is unset. It should become a GCE instance identity
  token before the fleet leaves one project.

## What the node may read

The node's service account —
`540236122367-compute@developer.gserviceaccount.com`, the project default —
holds **`roles/secretmanager.secretAccessor` on the whole project**. It reads
every app's secrets, not only the apps placed on it.

Recorded here because it is not in any file the deploy runs: it was applied with
`gcloud projects add-iam-policy-binding` on 5 Aug 2026, and IAM in this project
has no other home in the repository.

It was per-secret first, granted by the deploy on the fleet branch, and widening
it was a decision rather than a shortcut. A per-deploy binding only exists for
apps deployed since the binding was introduced, so `FLEET_PLACEMENT=1` — which
places every app without redeploying any of them — would have started every app
that has a database against a 403.

What it costs, stated so nobody has to rediscover it: one escape from one sandbox
reads every tenant's database password rather than one tenant's. What stands
between those is the nftables rule in `image/provision.sh`, which admits only
uid 0 and uid 987 (`supersonic`, the agent) to `169.254.169.254` and drops every
other uid — tenant code included. That rule is now load-bearing for the whole
fleet's secrets, not just for one app's.

Narrowing it again means a dedicated per-node service account and a binding
written at placement time rather than at deploy time.

## Who may reach the node

`default-allow-ssh` admitted `0.0.0.0/0` on tcp:22 — the GCP default, never
narrowed, on a box that holds every tenant's running code and, since the
paragraph above, can read every tenant's secrets. It is now
**`35.235.240.0/20`**, IAP's forwarding range, so ssh arrives only through
Identity-Aware Proxy and is subject to IAM rather than to whoever has a key.

Changed on 5 Aug 2026, and in that order deliberately: IAP access was proven
working FIRST — `gcloud compute ssh … --tunnel-through-iap` — because narrowing
the rule before knowing the replacement path works is how a node becomes
unreachable. Verified both ways afterwards: IAP connects, and a direct TCP probe
to the node's external address on 22 times out.

**Use `--tunnel-through-iap` from now on.** Plain `gcloud compute ssh` still
works only because it falls back to IAP itself; if it ever stops, this rule is
why.

`default-allow-rdp` (0.0.0.0/0 on tcp:3389) was deleted the same day. There has
never been a Windows instance in this project — it was an open port to nothing.

**Still open: the node has a public IP** (`35.255.177.212`). What it now exposes
is ICMP and nothing else, so the urgency went with the ssh rule — but removing
it is not a one-liner. The subnet has `privateIpGoogleAccess: False` and the
project has no Cloud Router and no Cloud NAT, so an instance with no external
address cannot reach Artifact Registry or Secret Manager at all: every app on
the node would fail its next image pull and the agent could not resolve a single
secret. The order is Private Google Access, then a Cloud Router and NAT, then
drop the address — and the last step cannot be verified until it is taken, which
is why it wants someone watching rather than a quiet commit.

## Not done

- **HTTPS.** The wildcard certificate needs a DNS authorization TXT record, and
  `supersonic.cv` is at Namecheap, not Cloud DNS. The load balancer serves HTTP
  today.
- **Fleet-wide routing.** A node serves the apps placed on it and returns a
  plain "not on this node" for anything else. Forwarding to the node that holds
  an app is the next piece.
- **The deploy pipeline does not know about any of this.** A deploy still goes to
  Cloud Run; `fleetctl` places an already-built image by hand.
- **Worker, cron and release processes.** Only `web` runs. This is the section of
  the plan that pays for the move and it is not built yet.
- **Volumes and Litestream.** `/data` is bind-mounted from local SSD and nothing
  replicates it.
- **Static apps** still go through the shared Cloud Run static server.
