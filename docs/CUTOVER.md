# Sharing layer — cutover checklist

Everything below the line is **built, deployed, and verified against production**.
What remains is the DNS switch, which is deliberately not done: it reroutes every
hosted app through the proxy in one step.

## Already done and proven

- `supersonic-proxy` runs on Cloud Run (`min-instances=1`), as its own service
  account, with Cloud SQL attached and secrets from Secret Manager.
- A global external load balancer fronts it: serverless NEG →
  `supersonic-proxy-backend` → `supersonic-lb` → HTTP frontend on **8.233.7.157**.
- Five pre-existing apps are recorded in `apps`, all `private`
  (`cursor-meetup`, `ss-mt-df8y2z`, `subio`, `subio-2`, `zs73v`).
- Verified through the load balancer with a real session:
  | Case | Result |
  |---|---|
  | owner of `subio` | 200, the app's own HTML |
  | a different signed-in user | 403, "you don't have access" |
  | garbage session cookie | 302 to sign-in |
  | unknown slug / off-domain Host | 404 |
- New deploys are sealed: `--no-allow-unauthenticated`, invoker granted only to
  the proxy and the control plane. Proven: a fresh service returns 403 anonymously
  while an app deployed by the old code still returns 200.

## The switch

Both routing models live in the code and are selected by one environment variable
on the control plane:

| `SEAL_APPS` | Deploy behaviour | Routing |
|---|---|---|
| unset (today) | `--allow-unauthenticated` + per-app domain mapping | `<slug>.supersonic.cv` -> Cloud Run directly |
| `1` (after cutover) | `--no-allow-unauthenticated` + invoker granted to the proxy | `*.supersonic.cv` -> load balancer -> proxy -> app |

They are mutually exclusive. Setting `SEAL_APPS=1` before DNS moves makes every
new app unreachable: the domain mapping still points straight at Cloud Run, which
now refuses anonymous callers. Flip it in step 5 below, not earlier.

The `apps` row is written either way, so the proxy is ready the moment DNS moves.

## Remaining, in this order

1. **Wildcard certificate.** Classic managed certs reject `*.supersonic.cv`
   ("Wildcard domains not supported"). Use Certificate Manager — see the commented
   block in `docs/superpowers/plans/2026-07-25-sharing-layer.md` Task 11 Step 4.
   The DNS authorization record it asks for reroutes nothing; it is safe to add early.

2. **Set `COOKIE_DOMAIN=.supersonic.cv`** on the control plane and redeploy.
   Without it the session cookie stays host-only and the proxy will bounce every
   visitor to sign-in in a loop.

3. **Re-run the backfill** (`node --import tsx apps/web/db/backfill-apps.ts`) so any
   app deployed since is present. An app missing from `apps` returns 404 the moment
   DNS moves.

4. **Point `*.supersonic.cv` at 8.233.7.157.** This is the irreversible step.
   Today the record points at `ghs.googlehosted.com` (per-app domain mappings).

5. **Set `SEAL_APPS=1`** on the control plane and redeploy. New deploys are sealed
   from this point; existing apps are unaffected until step 7.

6. **Decide the public-app story before sealing anything.** `landing`,
   `supersonic-landing`, and `supersonic-control-plane` are public on purpose and are
   excluded from the backfill. The sharing model has no "public" visibility — adding
   one is a product decision, not a migration step.

7. **Seal the remaining apps** once the proxy path is confirmed live:
   remove `allUsers` invoker, add the proxy service account.

## Rollback

Point DNS back at `ghs.googlehosted.com`. The per-app domain mappings were deleted
from the deploy path but existing mappings were never removed, so previously
deployed apps keep resolving. Nothing in the database needs undoing — the proxy is
the only thing that reads `apps`.

---

# Turning on Google sign-in

Three steps that need a browser and cannot be scripted. Everything else is done:
the allowlist table is seeded, the gate is live in `signIn`, and the button is wired.

1. **Create the OAuth client.** Cloud Console → APIs & Services → Credentials →
   Create credentials → OAuth client ID → **Web application**, in project
   `supersonic-deploy-prod`. Configure the consent screen first if prompted;
   `External` is required because two operators sign in with personal gmail addresses.

2. **Add the redirect URI**, exactly, scheme included:
   `https://<control-plane-host>/api/auth/callback/google`
   The host must match `AUTH_URL` on the deployed control plane. A mismatch is the
   single most common cause of `redirect_uri_mismatch`.

3. **Store and wire the credentials:**

   ```bash
   printf %s "<client-id>"     | gcloud secrets create supersonic-google-client-id     --data-file=- --project supersonic-deploy-prod
   printf %s "<client-secret>" | gcloud secrets create supersonic-google-client-secret --data-file=- --project supersonic-deploy-prod

   SA=$(gcloud run services describe supersonic-control-plane --region us-central1 \
        --project supersonic-deploy-prod --format='value(spec.template.spec.serviceAccountName)')
   for s in supersonic-google-client-id supersonic-google-client-secret; do
     gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:${SA}" \
       --role=roles/secretmanager.secretAccessor --project supersonic-deploy-prod
   done

   gcloud run services update supersonic-control-plane --region us-central1 \
     --project supersonic-deploy-prod \
     --update-secrets "GOOGLE_CLIENT_ID=supersonic-google-client-id:latest,GOOGLE_CLIENT_SECRET=supersonic-google-client-secret:latest"
   ```

Until step 3 lands, `auth.ts` does not register the provider and the button leads
nowhere. The code is inert, not broken.

**Verify before removing passwords:** sign in with Google as an operator and confirm
you land on your existing account with your existing apps — not a duplicate. Then sign
in with a Google account that is not on the allowlist and confirm the readable
"isn't on the invite list" message. Only then run Task 5 of
`docs/superpowers/plans/2026-07-27-verified-identity.md`.

## Managing the allowlist

Adding someone is one row, no redeploy:

```sql
INSERT INTO allowed_signins(email, note)  VALUES ('boris@acme.com', 'invited by arsen');
INSERT INTO allowed_signins(domain, note) VALUES ('acme.com',       'partner company');
```

Removing access is a DELETE — but it does **not** revoke anything already issued:

| What they hold | Does DELETE stop it? |
|---|---|
| A browser session | No — it survives until it expires. Rotating `AUTH_SECRET` signs everyone out. |
| A CLI token (`cli_tokens`) | **No.** These are database-backed bearer tokens, unaffected by `AUTH_SECRET`, and nothing re-checks them against the allowlist. Delete the person's rows from `cli_tokens` too. |

So a full revocation today is three steps: delete from `allowed_signins`, delete their
rows from `cli_tokens`, and rotate `AUTH_SECRET` if the session must die immediately.
Re-checking the allowlist on CLI token use is a known gap, not yet built.

---

# Fast deploys — infrastructure to create

The code for the three-lane pipeline is merged and **inert until these exist**. Every
new setting is read from an environment variable that defaults to today's behaviour,
so the control plane runs unchanged with none of them set. Turn them on in this order.

## 1. The static assets bucket

```bash
gcloud storage buckets create gs://supersonic-static-assets \
  --location us-central1 --project supersonic-deploy-prod \
  --uniform-bucket-level-access
```

## 2. The static server's identity

Least privilege from the start: read on one bucket, nothing else. This is deliberate —
an audit on 2026-07-27 found every hosted app inheriting the default compute account
with `run.admin`, `storage.admin` and `artifactregistry.writer`, and new services are
not going to repeat that.

```bash
gcloud iam service-accounts create supersonic-static \
  --display-name "Supersonic static server" --project supersonic-deploy-prod

gcloud storage buckets add-iam-policy-binding gs://supersonic-static-assets \
  --member "serviceAccount:supersonic-static@supersonic-deploy-prod.iam.gserviceaccount.com" \
  --role roles/storage.objectViewer --project supersonic-deploy-prod
```

## 3. Deploy the static server

```bash
cd services/static
gcloud run deploy supersonic-static \
  --source . --region us-central1 --project supersonic-deploy-prod \
  --service-account supersonic-static@supersonic-deploy-prod.iam.gserviceaccount.com \
  --set-env-vars ASSETS_BUCKET=supersonic-static-assets,ROOT_DOMAIN=supersonic.cv \
  --no-allow-unauthenticated --quiet

gcloud run services add-iam-policy-binding supersonic-static \
  --region us-central1 --project supersonic-deploy-prod \
  --member "serviceAccount:supersonic-proxy@supersonic-deploy-prod.iam.gserviceaccount.com" \
  --role roles/run.invoker
```

**Sealed, and it matters more here than for an ordinary app.** This one service fronts
every static app, and it decides which one to serve from the `x-supersonic-slug` header
the proxy sets. Left publicly invokable, anyone who knew the run.app URL could send that
header themselves and read a *private* app's files without ever passing the proxy's
access decision.

This was got wrong once during the rollout — the service went out with
`--allow-unauthenticated` on the belief that `SEAL_APPS` was off, when it was already
`1`. Caught by checking the live IAM policy afterwards rather than trusting the
assumption.

## 4. The regional npm mirror — created, deliberately NOT switched on

```bash
gcloud artifacts repositories create npm-mirror \
  --repository-format npm --mode remote-repository \
  --remote-repo-config-desc "npmjs" --remote-npm-repo NPMJS \
  --location us-central1 --project supersonic-deploy-prod
```

The repository exists. **`NPM_REGISTRY` is not set, and must not be set as-is.**

Artifact Registry npm repositories refuse anonymous reads — verified against the
live mirror, which answers `401` to an unauthenticated GET. Pointing builds at it
without credentials would fail every `npm install` in the platform at once.

Making it work needs an `.npmrc` carrying an access token in the build environment,
and that has a trap: writing a token into a Dockerfile bakes it into an image layer,
where it outlives the build and ships to whoever can pull the image. The static
lane can do this safely because we own its Cloud Build steps and can write `.npmrc`
in a step rather than a layer. The container lanes build from a customer-visible
Dockerfile (Kaniko today, buildx/BuildKit under `BUILDER=buildkit` — see
section 8), so they need a build-arg or a mounted secret instead.

Until that is built, leave `NPM_REGISTRY` unset. The base images below already
carry a warm package cache, which is where most of the cold-start win comes from.

## 5. The base image repository

```bash
gcloud artifacts repositories create bases \
  --repository-format docker --location us-central1 \
  --project supersonic-deploy-prod

infra/bases/refresh.sh
```

`refresh.sh` builds `:candidate`, smoke-tests it, and only then moves `:stable`. Run it
weekly. A failed refresh leaves `:stable` alone and exits non-zero — deploys keep using
the last good base, which is the whole point of the gate.

## 6. Switch the control plane on — done

Applied on 2026-07-27:

```bash
gcloud run services update supersonic-control-plane \
  --region us-central1 --project supersonic-deploy-prod \
  --update-env-vars \
STATIC_SERVICE=supersonic-static,\
ASSETS_BUCKET=supersonic-static-assets,\
NODE_BASE_IMAGE=us-central1-docker.pkg.dev/supersonic-deploy-prod/bases/node22:stable,\
NEXT_BASE_IMAGE=us-central1-docker.pkg.dev/supersonic-deploy-prod/bases/node22-next:stable
```

`NPM_REGISTRY` is deliberately absent — see section 4.

Each variable is independent, and unsetting any one reverts that piece with no
redeploy. Removing `STATIC_SERVICE` and `ASSETS_BUCKET` sends every project back
down the container path.

## How static apps are actually routed

Worth writing down, because the obvious answer is wrong and cost a round of
debugging.

All of `*.supersonic.cv` resolves to one load-balancer IP, so app traffic reaches
the **proxy** — not the per-app Cloud Run domain mappings, which DNS never points
at. Those mappings exist for several apps and are inert.

The proxy routes by looking up `apps.run_url`, so a static app's row points at the
shared static server. And because the proxy drops `Host` and lets the upstream
request set its own, the static server cannot learn which app a request was for
from the hostname — every static app shares that one upstream. The proxy therefore
names the app in `x-supersonic-slug`, which is safe to trust downstream precisely
because the proxy already discards anything a client sends under that prefix.

Consequence: a static deploy creates no domain mapping. There is nothing to map.

## 7. Apply the migration

`004_deploy_stages.sql` creates the per-stage timing table. It is additive and
idempotent like the rest.

```bash
cd apps/web && npx tsx db/migrate.ts
```

Nothing else in this section depends on it, but the lane timings in the design are
projections until this table has data behind them — so it is worth doing first, not last.

## 8. Container builder — buildx/BuildKit, behind `BUILDER`

Kaniko was archived by Google on 2025-06-03. `apps/web/lib/build-config.ts` can emit
either builder's Cloud Build config, chosen by one env var on the control plane:

```bash
BUILDER=buildkit   # buildx/BuildKit, registry cache in mode=max
# anything else, including unset → Kaniko (the default, unchanged)
```

Reverting is unsetting the variable and restarting — no code change, no redeploy of
customer apps. `mode=max` is the whole point of the switch: BuildKit's default
`mode=min` exports only layers that reach the final image, and our generated
Dockerfiles are multi-stage, so `npm install` lives in a build stage that `mode=min`
would throw away on every deploy.

**No Artifact Registry work is needed.** The cache goes to
`us-central1-docker.pkg.dev/supersonic-deploy-prod/cloud-run-source-deploy/<slug>-cache`,
tag `cache` — the same repo and image path Kaniko already writes, only a new tag. A
cache ref that does not exist yet makes buildx log an `ERROR` and continue (exit 0),
so the first build for an app creates it. `ignore-error=true` on `--cache-to` is what
keeps a broken or unreachable cache from failing a customer's deploy.

Checking a build actually hit the cache:

```bash
gcloud builds log <BUILD_ID> --region us-central1 --project supersonic-deploy-prod \
  | grep -E "inferred cache manifest type|failed to configure registry cache importer|writing cache image manifest|error writing layer blob|CACHED"
```

Read it like this:

| line | means |
| --- | --- |
| `inferred cache manifest type: …` | the registry cache was found and read — **a hit** |
| `failed to configure registry cache importer: …: not found` | cold cache, i.e. the first build for this app. Harmless, exit 0 |
| `failed to configure registry cache importer: …` (anything else) | a real problem — no reader grant, deleted repo, unreachable registry |
| `#N CACHED` | that layer was reused. From the registry cache *or* from the worker's local state |
| `writing cache image manifest …` | the cache really was written for the next build |
| `ERROR: error writing layer blob: …` | the cache export failed. `ignore-error=true` keeps the build green, but no cache was written |

Two traps, both of which had this documented backwards and shipped a filter that
lied to customers:

- **`importing cache manifest from …` is not a hit.** It is the label buildx prints
  when it *starts* the import; on a cold cache the very next line is
  `ERROR: failed to configure registry cache importer: …: not found`. It appears on
  every build, warm or cold, and again in buildx's closing error summary.
- **`exporting cache to registry` is not a write.** Same story: it is the label. An
  export that cannot reach the registry prints it and then
  `ERROR: error writing layer blob: …`.

The rule for both: match the *outcome* line, never the label.

Earlier revisions of this document said "do **not** grep for `CACHED` — a layer
fetched from the registry cache is reported as `DONE <n>s`". That is wrong; warm
runs show `#8 CACHED` / `#9 CACHED` for exactly those layers. It is also not
sufficient on its own — a cold build on a worker with warm *local* state prints
`CACHED` too — which is why `inferred cache manifest type` is the line to key on.

The deploy stream translates all of this into plain English (`lib/build-config.ts`,
`buildLogLine`), so a customer never sees the cold-cache `ERROR`.

**Docker Hub is on the critical path of this lane.** `docker buildx create --driver
docker-container` pulls `moby/buildkit:buildx-stable-1` from Docker Hub on every
build — a real captured run shows `#1 pulling image moby/buildkit:buildx-stable-1
15.1s done`. Kaniko had no such dependency (gcr.io, Google-hosted), and Cloud Build
workers share egress IPs, so Docker Hub's anonymous pull limit is a **hard deploy
failure** for the whole container lane, not a slow build. This is the same class of
problem the AR node-base mirror was created to remove ("removes a Docker Hub pull —
and its rate limit — from every build", `app/api/deploy/route.ts`).

```
BUILDKIT_IMAGE=us-central1-docker.pkg.dev/supersonic-deploy-prod/…/buildkit:v0.23
```

Unset by default, deliberately: a mirror that does not exist yet must not be able to
take deploys down either. Mirror the image into AR and set this **before** turning
`BUILDER=buildkit` on for real traffic.

**Registry auth for `--push` is unverified.** `gcr.io/cloud-builders/docker` ships no
`/root/.docker/config.json` and no credential helper — checked by running the image.
The push and both cache endpoints therefore depend on Cloud Build injecting a docker
config at step runtime, that config covering `us-central1-docker.pkg.dev`, and buildx
forwarding it into the `docker-container` driver's session. Three links, none of them
exercised. If any fails, every Dockerfile deploy fails with `denied` the moment
`BUILDER=buildkit` is set — total failure of the lane, not a degraded cache. Kaniko
authenticated itself. **Test this on one app before any wider rollout.**

**Before this goes wide:** `cloud-run-source-deploy` has `cleanupPolicies: NONE`, and a
registry cache has no TTL analogue to Kaniko's `--cache-ttl=168h`. Under `mode=max`
every intermediate layer is written on every build, so add an AR cleanup policy
matching `*-cache` or the repo grows without bound. This is cost, not correctness.

## Not done here: the hosted-app runtime account

`APP_RUNTIME_SERVICE_ACCOUNT` is read by the deploy route and unset, so hosted apps still
inherit the default compute account and its project-wide admin roles. Creating a
locked-down account and trimming the default one's roles is a separate, higher-risk
change — Cloud Build and the control plane both lean on those roles, and cutting them
blind will take the platform down. It needs its own careful pass.

## 9. The screenshot service — done

Applied on 2026-07-30. `services/shot` is a Cloud Run service running Chromium; it takes
one picture of an app and writes it to `gs://supersonic-static-assets/_thumbs/<slug>.jpg`.
The dashboard shows that image instead of what it used to do, which was render a live
`<iframe>` of every app on the page.

What it is wired to:

```
supersonic-shot           us-central1, sealed, SA supersonic-shot@…
  ← invoked by            supersonic-deployer@…            (run.invoker)
  → writes                gs://supersonic-static-assets    (storage.objectAdmin)
control plane env         SHOT_SERVICE_URL=https://supersonic-shot-uyuwsbguuq-uc.a.run.app
```

The control plane mints both tokens — one for the shot service's audience, one for the
app's — and passes the app's token in the request body. The shot service never mints
anything, which is why it needs no `run.invoker` on user apps: adding one per deploy would
be another IAM write on the hot path. The deployer account needed `run.invoker` on
`supersonic-static` for this; it had it on container apps already, via the same grant
`probeApp` depends on.

Two constraints that are not obvious and did break in production:

- **`playwright-core`'s version must match the base image tag exactly**, and is pinned for
  that reason. A `^1.49.0` range resolved to 1.62.0 against a `v1.49.0-jammy` image and
  Chromium was not where that build looked for it.
- **`page.screenshot()` takes png or jpeg only.** WebP is refused at runtime, not at
  build time.

Calls are fire-and-forget: a deploy never waits for a picture, and a failed screenshot is
logged and dropped. An app that answers non-2xx gets no picture at all, so a card falls
back to its monogram rather than showing a photograph of an error page.
