# The fleet is the only deploy target for apps that run a server

Supersonic was built to deploy every app as its own Cloud Run service, and later
grew a fleet of Compute Engine VMs as a second target. Keeping both honestly means
paying for a seam, two sets of tests, and twice the failure surface — and as of
2026-08-06 nobody is using the second option: 80 of 89 recorded deploys are our own,
and the six other owners between them have nine deploys and no failures. We are
choosing the fleet as the only target for apps that run a server, and deleting the
Cloud Run path rather than maintaining it, because the cost of breaking things is
lower now than it will ever be again.

**Static apps stay on Cloud Run, permanently.** They are served by one shared static
server rather than a service per app, they are already the fastest path we have
(26 s), and they have almost nothing in common with starting containers. Calling
this "for now" would record a debt that does not exist; it is a second product with
different physics.

## Consequences worth stating

Four Cloud Run capabilities do not survive the move, and none has a fleet
equivalent today: traffic splitting and instant revision rollback (the fleet keeps
one overwritten spec row and no history), scale-to-zero and per-request concurrency
capping (one resident process, no multiplexer), IAM-scoped per-service auth (the
fleet uses one shared secret valid for any app on a node), and Cloud Run Jobs
semantics for `release` and `cron` (no isolated per-execution resource). Losing them
is the price, not an oversight.

The apps already running on Cloud Run are left alone — not migrated, not deleted.
Some belong to other people, and moving a working app for the sake of architectural
tidiness is a risk taken in somebody else's garden.

## Implemented, 2026-08-13

The Cloud Run container lane is deleted. `runDeploy` is gone, the fork that chose
between two runtimes is gone, and `fleetPlacementWanted` — the canary gate — went
with it: a gate needs somewhere to send what it turns away. An app the fleet
cannot take is now a failed deploy naming the reason, not a silent fall to a lane
that no longer exists.

The RUNNER lane went too, and that was not scope creep. Its image was one shared
prebuilt runtime with the customer's code arriving encrypted at start, so a node
handed it starts the runner and never the app — Cloud Run was the only place it
could run. With it went `RUNNER`, the effect of a pinned runtime on the lane, and
the rule that an agent's `--run` outranked a committed Dockerfile.

Static is untouched and the decision above holds: `runStatic` uploads to a bucket
served by `supersonic-static`, and it short-circuits before the container path is
reached. It never used the lane that was deleted.

### What the existing Cloud Run apps actually look like now

This ADR said they would be left alone — "somebody else's garden" — and they were.
Measured today, three days of request logs, with the query verified against
services known to be serving:

- 13 tenant services duplicate an app that is ALSO running on the fleet, put there
  by the hand migration (`services/fleet/migrate.sh`). Every one has had ZERO
  requests in three days: traffic goes to the fleet and the Cloud Run copy is dark.
  They scale to zero, so they cost nothing and harm nothing.
- `dp7ul-release`, `kngsu-release` and the `ss-exec-*` jobs are dark for the same
  reason — a release is now a process in the AppSpec the node runs.
- Two worker pools are genuinely live, `hdhxq-bot` and `uwovg-queue`, and they are
  NOT duplicates: neither app is on the fleet at all.

NOTHING IS DOUBLE-RUNNING, which was the risk worth checking. A dark web service
is idle; a second live worker would have been a bot double-polling.

They are not deleted here, and no sweep is needed: the next deploy of any of these
apps cleans up after itself. `deployProcesses` is called with an empty process
list, and its own orphan pass then removes the worker pools and jobs the app has
on Cloud Run — the machinery already existed and this is exactly what it is for.
