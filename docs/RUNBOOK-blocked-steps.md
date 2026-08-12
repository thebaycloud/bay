# The switches, and which of them are already thrown

This file collected the steps that were written but not turned on. Most are now
on. What follows is what was done, how to see it, and how to undo it — plus the
two that remain and why.

Everything here was verified on 12 Aug rather than assumed.

---

## Done

### The node's project-wide secret access — removed

`roles/secretmanager.secretAccessor` is no longer on
`540236122367-compute@developer.gserviceaccount.com`. §9 of the architecture
spec is the first thing tonight that made anything actually safer rather than
merely ready.

**How it was verified.** A running app does not re-resolve its secrets, so only
a START proves anything. `izuvx--nightly` and `rtmsw--nightly` fire every ten
minutes on `fleet-lab-2`; both finished at 00:40:02, nine minutes after the
binding was removed, having resolved their secrets through the broker on a node
whose identity can no longer read Secret Manager at all.

**Undo:**

```bash
gcloud projects add-iam-policy-binding supersonic-deploy-prod \
  --member=serviceAccount:540236122367-compute@developer.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor
```

**Still worth doing, and out of scope for §9:** that service account is the
DEFAULT compute one — the identity of every fleet node — and it also holds
`run.admin`, `storage.admin`, `cloudbuild.builds.builder` and
`iam.serviceAccountUser`. `run.admin` on a box whose job is running other
people's code means an escape can delete every Cloud Run service in the project.
§9 removed one of five.

### Railpack — the default builder

`BUILDER=railpack` and `BUILDKIT_HOST` live in `_LANE_ENV` in `cloudbuild.yaml`,
not in a console session. That distinction is the whole entry: a canary set with
`gcloud run jobs update` worked and was silently reverted by the next
control-plane deploy, because `_LANE_ENV` is reapplied every time.

**Undo:** change `BUILDER` back to `buildkit` in `cloudbuild.yaml` and deploy.

### The build plane — `buildkit-1`

A long-lived BuildKit with its cache on local SSD, reached by the deploy job
over mTLS through Direct VPC egress. No external address; egress via a Cloud NAT
created for it.

**Measured:** the first build took the cache from 120 KB to 2.0 GB; the next
deploy of the same app was 101 s end to end and left the cache unchanged. In one
of those deploys, `Building on the fleet's own BuildKit` is logged at 03:04:07
and the app prints `listening on 8080` at 03:04:26 — nineteen seconds for build,
push, placement and start.

**Undo:** clear `BUILDKIT_HOST` from `_LANE_ENV`; builds return to Cloud Build.

### Node three, and the fleet's second door

`fleet-lab-3` is in `us-central1-b`, so the fleet spans two zones and quorum can
evict for the first time.

Found while doing it: `fleet-backend` had ONE backend instance group holding
`fleet-lab-1`. `fleet-lab-2` was healthy with 26 routes and reachable only by
forwarding from the other node — losing `fleet-lab-1` would have taken every app
down while a good node sat behind no load balancer. All three are backends now.

### The warm deploy worker

`supersonic-deploy-worker` runs the same image and the same pipeline as the Job,
already started. The Job costs ~118 s before the pipeline's first line; the
worker is one HTTP hop.

**Every refusal is safe.** Anything that is not an explicit 202 — busy, wrong
commit, unreachable, absent — dispatches to the Job exactly as before.

**Undo:** `gcloud run services update supersonic-control-plane
--remove-env-vars DEPLOY_WORKER_URL`. Nothing else, and no code change.

---

## Not done

### Split the platform database off the shared instance

`supersonic-shared-pg` is a single `db-f1-micro` holding every tenant's database
AND the platform's own — placements, leases, releases, the reconciler's record.
The control plane cannot survive an incident on an instance any tenant can
saturate, and at that tier saturating it is not hard.

Spec §10. No code; the platform's connection string is configuration.

**Left undone deliberately.** It is a live migration of the control plane's own
state, and the safe version rehearses on a copy first. That is a bad thing to
begin unattended, not a hard thing.

### Delete the Cloud Run app path

47 Cloud Run services exist; six are the platform, and the rest are apps —
including apps that predate the fleet. The reconciler reports 28 placements, so
the two sets do not line up, and which of the ~41 are dead is not answerable
from the outside.

**Left undone deliberately.** Deleting a service for an app that is not on the
fleet takes that app down. The inventory has to come first, and it comes from
the platform database rather than from `gcloud run services list`.
