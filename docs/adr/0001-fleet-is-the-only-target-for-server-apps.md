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
