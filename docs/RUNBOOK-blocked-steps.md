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

### The rest of the node's privileges — narrowed

§9 removed one of five; the other four are gone now. That service account is the
DEFAULT compute one, so it is the identity of every fleet node AND of the build
host, and it held `run.admin`, `storage.admin`, `cloudbuild.builds.builder` and
`iam.serviceAccountUser`. `run.admin` on a box whose job is running other
people's code means an escape can delete every Cloud Run service in the project.

**What it actually needs, established by reading rather than by guessing:** the
agent's only direct cloud call was Secret Manager and that is now the broker;
`update-agent.sh` READS the agent binary from GCS; images are pulled by
containerd; the SQL proxy needs `cloudsql.client`; the ops agent needs
`logging.logWriter`. Nothing on the node writes to GCS or pushes an image, and
BuildKit pushes with a token the deploy job sends rather than an identity of its
own.

| before | after |
|---|---|
| artifactregistry.**writer** | artifactregistry.**reader** |
| storage.**admin** | storage.**objectViewer** |
| run.admin, cloudbuild.builds.builder, iam.serviceAccountUser | *removed* |
| cloudsql.client, logging.logWriter | unchanged |

Granted narrow BEFORE revoking broad, so there was never a gap. Verified after:
both agents and both SQL proxies active, `supersonic-update-agent` ran clean on
two nodes, and a full deploy pulled its image and reached `listening on 8080`.

**Undo:** re-add any role with `gcloud projects add-iam-policy-binding`.

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

**The inventory, taken from the platform database on 12 Aug.** It is the thing
that was missing, and it says the path is not leftovers — it is half the
platform:

| | apps | placed on the fleet |
|---|---|---|
| `runtime = fleet` | 28 | 28 |
| `runtime = cloudrun` | 38 | 0 |

Of those 38: **20 live**, 14 `failed`, 4 stuck in `deploying`. So the work is
moving twenty apps, not sweeping up dead services.

**And the database disagrees with the world.** Cross-checking the 20 live ones
against `gcloud run services list`: seven have NO Cloud Run service at all
(`choqd`, `mmon4`, `oh6sn`, `q13fh`, `wmc7r`, `z0s7e`, `zzppg`) and still answer
over HTTP. `zp6t0` has a service and answers `000`. `hdhxq` and `hl52l` answer
404. So `runtime = 'cloudrun'` does not reliably mean "served by a Cloud Run
service", and no bulk action should be taken on that column until it does.

**Why this is not one loop over twenty slugs.** The platform does not store the
repository a deployed app came from — `apps` has no `repo_url`, and the deploy
run that carried it is deleted when the run finishes. So there is nothing to
redeploy FROM. Moving an app without its source means adopting its existing
image: read the live Cloud Run service for image, env, secret references and
port, build an `AppSpec` from that, record a release, set desired, wait for the
node to report ready, and only then flip `apps.runtime` and delete the service.

That is a real feature and a safe one — the cutover is the `runtime` flip and it
is reversible — but it is a feature, not an afternoon of `gcloud` commands, and
it should be written with the data reconciled first.
