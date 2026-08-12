# Steps that need a human hand

Everything here is written, tested and deployed. What remains is a switch, and
each switch is one command. They are collected because the agent working on them
cannot run them: the sandbox refuses infrastructure mutations — IAM policy,
Cloud Run job env, `compute instances create`, `sql instances create` — so the
code landed and the flip did not.

Ordered by value. Each entry states what it changes, how to see it worked, and
how to undo it.

---

## 1. Remove the node's project-wide secret access

**This is the one that actually removes risk.** Until it runs, `§9` of the
architecture spec is written and nothing is safer: the broker is live, both
nodes already resolve every secret through it, and the old grant sits unused but
open. An escape from a sandbox that reaches the metadata credentials still reads
every tenant's database password.

```bash
gcloud projects remove-iam-policy-binding supersonic-deploy-prod \
  --member=serviceAccount:540236122367-compute@developer.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor \
  --condition=None
```

`--condition=None` is required: the project policy contains conditional bindings
elsewhere, so gcloud refuses an unqualified removal. The binding being removed
is itself unconditioned — verified, there is exactly one.

**Why it is safe now.** Both nodes run agent `fcddda9`, which has NO fallback to
Secret Manager — `resolveAll` goes to the broker whenever `FLEET_ENDPOINT` is
set, and `fleet-lab-1` logged `secrets resolve through …/api/fleet/secrets` at
22:43:38 on 11 Aug. The grant is already dead weight; removing it changes
nothing that works today.

**How to see it worked.** A running app does not re-resolve, so watch a START.
The cheapest one is a cron: `rtmsw--nightly` and `izuvx--nightly` fire every ten
minutes on `fleet-lab-2` and each firing resolves secrets.

```bash
gcloud compute ssh fleet-lab-2 --zone us-central1-a \
  --project supersonic-deploy-prod --tunnel-through-iap \
  --command 'sudo grep -a "cron finished\|cron FAILED" /var/log/supersonicd.log | tail -4'
```

Two more `cron finished` lines after the change is the proof. A `403` naming a
secret would be the failure — and would mean the broker is not being used after
all, which is the assumption above rather than a consequence of the removal.

**Undo:**

```bash
gcloud projects add-iam-policy-binding supersonic-deploy-prod \
  --member=serviceAccount:540236122367-compute@developer.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor
```

**While you are in there:** that service account also holds `roles/run.admin`,
`roles/storage.admin`, `roles/cloudbuild.builds.builder` and
`roles/iam.serviceAccountUser`. It is the DEFAULT compute service account, so it
is the identity of every fleet node — and `run.admin` on a box whose job is to
run other people's code means an escape can delete every Cloud Run service in
the project. Narrowing it is its own piece of work and is not part of §9, but it
is worth knowing that §9 removes one of five things worth removing.

---

## 2. Put one app on the Railpack lane

The lane is built, tested and deployed; `RAILPACK_APPS` is empty, so no app
takes it and nothing has changed for anyone.

```bash
gcloud run jobs update supersonic-deploy-job \
  --region us-central1 --project supersonic-deploy-prod \
  --update-env-vars RAILPACK_APPS=<slug>
```

**Choosing the app.** A backend or API app, not a frontend. The address hint on
this lane is newer code than the Dockerfile route's — it reads names out of the
app's `.env` files rather than out of `ARG` declarations — so a bundle that
needs `VITE_API_URL` is the case most worth proving second, not first.

An app that ships its own `Dockerfile` is not a test of anything: the lane
declines it on purpose and builds the author's file, saying so in the deploy log.

**How to see it worked.** The deploy log says `Railpack planned this build — …`
and the Cloud Build step runs `buildx … --build-arg BUILDKIT_SYNTAX=… -f
railpack-plan.json`. A build that says `Base pinned to …` instead is the
Dockerfile lane, meaning the canary did not take.

**Undo:** `--remove-env-vars RAILPACK_APPS`, then redeploy the app.

---

## 3. Node three

Quorum is a majority of live, non-draining nodes. With two nodes a majority is
two, so ONE silent node puts the fleet below the threshold and eviction never
fires — in either direction, at any silence. The reconciler can place and drain
today; it cannot take a placement back from a node that has gone quiet, and it
will not be able to until there are three. This is not a tuning problem: lowering
the bar makes a two-node fleet evict on a partition in whichever direction the
control plane happens to be reachable from, which is the two-copies hazard the
lease exists to prevent.

`fleet-lab-2` is an `e2-standard-4`; a third like it is the cheapest thing that
makes the guarantee real.

Provision with `services/fleet/image/provision.sh` — it is idempotent and is the
same script that maintains the existing nodes. The node needs
`/etc/supersonic/agent.env` with `FLEET_ENDPOINT` and `FLEET_TOKEN`, which is
NOT written by that script and is not in the repository; copy it from an
existing node.

---

## 4. Split the platform database off the shared instance

`supersonic-shared-pg` is a single `db-f1-micro` holding every tenant's database
AND the platform's own — placements, leases, releases, the reconciler's record.
The control plane cannot survive an incident on an instance that any tenant can
saturate, and the tier means saturating it is not hard.

Spec §10. No code: the platform's connection string is configuration.

---

## 5. The build plane

Railpack landed on the EXISTING lane, which is buildx on a fresh Cloud Build
worker with a registry cache — what §3 called "not a cache; a slow registry".
The measured build block is 54 s of a 238 s deploy and Railpack alone does not
remove it. A long-lived BuildKit with a local cache is what collects that.

This is the largest remaining spend and the only one that buys latency directly.
